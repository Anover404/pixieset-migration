import { Logger } from "./logger.js";
import { StateStore } from "./stateStore.js";
import {
  fetchBootstrap,
  fetchDashboard,
  fetchCollectionDetail,
  fetchGalleryDetail,
  DashboardResponse,
  BootstrapResponse
} from "../services/pixieset.api.js";
import { createPixiesetAlbum, getPixiesetUploadUrl, GetUploadUrlResponse } from "../services/backend.api.js";
import { sleep } from "../utils/sleep.js";
import { retryWithBackoff, shouldRetryHttpError } from "../utils/retry.js";
import { PauseState, FailedImage, CollectionFailureInfo, MigrationSummary, PixiesetPhoto } from "./models.js";

const LOGGER_TAG = "[worker]";
const logger = new Logger();
const stateStore = new StateStore();

/**
 * Send x-goog-meta-* headers on upload. Must be true when backend signs URLs with metadata (metadata array in get-pixieset-upload-url).
 */
const INCLUDE_OBJECT_METADATA = true;

/** GCS custom metadata keys to include (x-goog-meta-<key>) */
const PHOTO_METADATA_KEYS = [
  "id",
  "gallery_id",
  "collection_id",
  "name",
  "mime_type",
  "ext",
  "size",
  "width",
  "height",
  "rank",
  "status",
  "capture_date",
  "watermark",
  "mark_private_at",
  "visibility_status",
  "starred"
] as const;

/**
 * Builds x-goog-meta-* headers from a Pixieset photo for GCS object metadata.
 * Only includes defined values; numbers and booleans are stringified.
 */
function buildPhotoMetadataHeaders(photo: PixiesetPhoto): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const key of PHOTO_METADATA_KEYS) {
    const value = photo[key as keyof PixiesetPhoto];
    if (value === undefined || value === null) continue;
    const str =
      typeof value === "boolean" ? (value ? "true" : "false") : String(value);
    headers[`x-goog-meta-${key}`] = str;
  }
  return headers;
}

/**
 * Concurrency limiter: processes items in parallel batches
 * Properly tracks completion count regardless of execution order
 */
async function processWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  processor: (item: T, index: number) => Promise<R>,
  onProgress?: (index: number) => void
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let completedCount = 0;
  let nextIndex = 0;
  
  // Process items with concurrency limit
  const processNext = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      const item = items[currentIndex];
      
      try {
        const result = await processor(item, currentIndex);
        results[currentIndex] = result;
      } catch (error) {
        // Store error result
        results[currentIndex] = undefined as R;
        throw error;
      }
      
      // Update completion count and call progress callback
      completedCount++;
      if (onProgress) {
        onProgress(completedCount);
      }
    }
  };
  
  // Start up to 'concurrency' number of workers
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(processNext());
  }
  
  // Wait for all workers to complete
  await Promise.all(workers);
  
  return results;
}

/**
 * Downloads and uploads a single photo using streaming
 */
async function processPhoto(
  photo: PixiesetPhoto,
  collectionName: string,
  username: string,
  collectionId: number,
  galleryId: number,
  photoIndex: number,
  albumId?: string,
  uploadUrlResponse?: GetUploadUrlResponse
): Promise<{ success: boolean; failedImage?: { id: string; name: string; reason?: string } }> {
  // Check if paused before processing
  if (await stateStore.isPaused()) {
    // Save pause state
    await stateStore.setPaused(true, { collectionId, galleryId, photoIndex });
    return { success: false };
  }
  const photoId = String(photo.id);
  const photoName = (photo.name as string) ?? `photo-${photo.id}.jpg`;
  
  const pathXxlarge = photo.path_xxlarge;
  if (!pathXxlarge) {
    return { success: false, failedImage: { id: photoId, name: photoName, reason: "Missing image path (path_xxlarge)" } };
  }

  try {
    // Use pre-fetched presigned URL if provided, otherwise fetch individually (fallback)
    let urlResponse: GetUploadUrlResponse;
    if (uploadUrlResponse) {
      urlResponse = uploadUrlResponse;
    } else {
      // Fallback: fetch individually if not provided (shouldn't happen in normal flow)
      const metadataList = [buildPhotoMetadataHeaders(photo)];
      const response = await getPixiesetUploadUrl(photoName, collectionName, username, albumId, metadataList);
      if (Array.isArray(response)) {
        // Shouldn't happen for single request, but handle it
        urlResponse = response[0] || { ok: false, error: "Unexpected batch response" };
      } else {
        urlResponse = response;
      }
    }

    if (!urlResponse.ok) {
      const errorMsg = urlResponse.error ?? `Failed to get upload URL (HTTP ${urlResponse.error || 'unknown'})`;
      logger.error(`${LOGGER_TAG} Failed to get upload URL for ${photoName}`, urlResponse);
      return { success: false, failedImage: { id: photoId, name: photoName, reason: errorMsg } };
    }

    // If file already exists, skip
    if (urlResponse.skipped) {
      logger.info(`${LOGGER_TAG} Photo ${photoName} already exists, skipped`);
      return { success: true };
    }

    if (!urlResponse.uploadUrl) {
      const errorMsg = "No upload URL returned from backend";
      logger.error(`${LOGGER_TAG} ${errorMsg} for ${photoName}`);
      return { success: false, failedImage: { id: photoId, name: photoName, reason: errorMsg } };
    }

    const uploadUrl = urlResponse.uploadUrl;
    const objectPath = urlResponse.objectPath;

    // Download and upload image using streaming with retries
    // Note: Since the stream is consumed on upload, we need to re-download for each retry attempt
    const imageUrl = pathXxlarge.startsWith("//") ? `https:${pathXxlarge}` : pathXxlarge;
    
    // Retry the entire download + upload process
    // This ensures we get a fresh stream for each retry attempt
    await retryWithBackoff(
      async () => {
        // Download image
        const downloadResponse = await fetch(imageUrl);
        if (!downloadResponse.ok) {
          throw { status: downloadResponse.status, statusText: downloadResponse.statusText };
        }
        if (!downloadResponse.body) {
          throw new Error("No response body received from image download");
        }

        // Upload to GCP using presigned URL (streaming)
        // Note: Must use "application/octet-stream" to match what backend signed
        // 'duplex: half' is required for streaming request bodies in Chrome extensions
        // x-goog-meta-* headers store photo details as GCS object metadata (only if backend signs with them)
        const uploadHeaders: Record<string, string> = {
          "Content-Type": "application/octet-stream"
        };
        if (INCLUDE_OBJECT_METADATA) {
          Object.assign(uploadHeaders, buildPhotoMetadataHeaders(photo));
        }
        const uploadResponse = await fetch(uploadUrl, {
          method: "PUT",
          headers: uploadHeaders,
          body: downloadResponse.body, // Stream directly - no memory accumulation
          duplex: "half" // Required for streaming request bodies in Chrome extensions
        } as RequestInit & { duplex: "half" });

        if (!uploadResponse.ok) {
          throw { status: uploadResponse.status, statusText: uploadResponse.statusText };
        }
        return uploadResponse;
      },
      3, // maxRetries
      1000, // initialDelayMs
      shouldRetryHttpError
    );

    // Stream is consumed and closed, response objects will be GC'd after function returns
    logger.info(`${LOGGER_TAG} Successfully uploaded ${photoName} to ${objectPath}`);
    
    // Check if paused after photo processing (in case pause was triggered during upload)
    if (await stateStore.isPaused()) {
      // Save pause state at current position
      await stateStore.setPaused(true, { collectionId, galleryId, photoIndex: photoIndex + 1 });
    }
    
    return { success: true };
  } catch (error) {
    let errorMsg: string;
    if (error && typeof error === 'object' && 'status' in error && 'statusText' in error) {
      errorMsg = `HTTP ${(error as { status: number }).status}: ${(error as { statusText: string }).statusText}`;
    } else {
      errorMsg = error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
    }
    logger.error(`${LOGGER_TAG} Error processing photo ${photoName}`, error as Record<string, unknown>);
    
    // Save pause state on error if paused
    if (await stateStore.isPaused()) {
      await stateStore.setPaused(true, { collectionId, galleryId, photoIndex });
    }
    
    return { success: false, failedImage: { id: photoId, name: photoName, reason: errorMsg } };
  }
}

/**
 * Processes all photos in a gallery
 */
async function processGallery(
  galleryId: number,
  collectionId: number,
  collectionName: string,
  username: string,
  onPhotoComplete?: (currentPhotoInCollection: number) => void,
  pauseState?: PauseState,
  albumId?: string,
  concurrency: number = 1
): Promise<{ success: boolean; photoCount: number; failedImages: Array<{ id: string; name: string }> }> {
  try {
    // Check if we should skip this gallery based on pause state
    if (pauseState && pauseState.collectionId === collectionId && pauseState.galleryId !== undefined) {
      if (pauseState.galleryId > galleryId) {
        // Gallery was already processed before pause, skip it
        return { success: true, photoCount: 0, failedImages: [] };
      }
      // If pauseState.galleryId < galleryId, we process normally (gallery after pause point)
      // If pauseState.galleryId === galleryId, we resume from photoIndex (handled below)
    }
    
    const galleryDetail = await fetchGalleryDetail(galleryId, collectionId);
    const photos = galleryDetail?.data?.photos ?? [];
    
    // Determine starting photo index if resuming
    let startPhotoIndex = 0;
    if (pauseState && pauseState.collectionId === collectionId && pauseState.galleryId === galleryId && pauseState.photoIndex !== undefined) {
      startPhotoIndex = pauseState.photoIndex;
      logger.info(`${LOGGER_TAG} Resuming gallery ${galleryId} from photo index ${startPhotoIndex}`);
    }
    
    // Get photos to process
    const photosToProcess = photos.slice(startPhotoIndex);
    
    // Batch fetch presigned URLs for all photos in this gallery
    const photoFilenames = photosToProcess.map(photo => (photo.name as string) ?? `photo-${photo.id}.jpg`);
    let presignedUrlMap: Map<string, GetUploadUrlResponse> = new Map();
    
    if (photoFilenames.length > 0) {
      try {
        const metadataList = photosToProcess.map(photo => buildPhotoMetadataHeaders(photo));
        logger.info(`${LOGGER_TAG} Batch fetching ${photoFilenames.length} presigned URLs for gallery ${galleryId}`);
        const batchResponse = await getPixiesetUploadUrl(photoFilenames, collectionName, username, albumId, metadataList);
        
        if (Array.isArray(batchResponse)) {
          // Create a map of filename -> presigned URL response
          for (let i = 0; i < photoFilenames.length && i < batchResponse.length; i++) {
            presignedUrlMap.set(photoFilenames[i], batchResponse[i]);
          }
          logger.info(`${LOGGER_TAG} Successfully fetched ${presignedUrlMap.size} presigned URLs for gallery ${galleryId}`);
        } else {
          // Fallback: single response (shouldn't happen for batch, but handle gracefully)
          logger.warn(`${LOGGER_TAG} Expected batch response but got single response for gallery ${galleryId}`);
          if (batchResponse.ok) {
            presignedUrlMap.set(photoFilenames[0], batchResponse);
          }
        }
      } catch (error) {
        logger.error(`${LOGGER_TAG} Failed to batch fetch presigned URLs for gallery ${galleryId}`, error as Record<string, unknown>);
        // Continue processing - processPhoto will handle missing URLs gracefully
      }
    }
    
    let successCount = 0;
    const failedImages: Array<{ id: string; name: string }> = [];
    // Start processedCount from startPhotoIndex to account for photos already processed
    let processedCount = startPhotoIndex; // Track all photos processed (success + failure)
    
    // Process photos with concurrency
    const photoResults = await processWithConcurrency(
      photosToProcess,
      concurrency,
      async (photo, batchIndex) => {
        const actualIndex = startPhotoIndex + batchIndex;
        
        // Check if paused before processing
        if (await stateStore.isPaused()) {
          await stateStore.setPaused(true, { collectionId, galleryId, photoIndex: actualIndex });
          return { success: false, failedImage: undefined };
        }
        
        // Get the presigned URL response from the map
        const photoName = (photo.name as string) ?? `photo-${photo.id}.jpg`;
        const uploadUrlResponse = presignedUrlMap.get(photoName);
        
        const result = await processPhoto(photo, collectionName, username, collectionId, galleryId, actualIndex, albumId, uploadUrlResponse);
        
        // Check if paused after processing
        if (await stateStore.isPaused()) {
          await stateStore.setPaused(true, { collectionId, galleryId, photoIndex: actualIndex + 1 });
        }
        
        return result;
      },
      (completedCount) => {
        // Update processed count
        processedCount = startPhotoIndex + completedCount;
        
        // Call progress callback after each photo (even if failed, to track progress)
        if (onPhotoComplete) {
          onPhotoComplete(processedCount);
        }
      }
    );
    
    // Process results and check for pause
    // Ensure all results are processed (filter out undefined results from errors)
    for (let i = 0; i < photoResults.length; i++) {
      const result = photoResults[i];
      if (!result) {
        // Result is undefined (likely an error that was caught and rethrown)
        // Count it as failed
        continue;
      }
      if (result.success) {
        successCount++;
      } else if (result.failedImage) {
        failedImages.push(result.failedImage);
      }
      
      // Check if paused during processing
      if (await stateStore.isPaused()) {
        const actualIndex = startPhotoIndex + i;
        await stateStore.setPaused(true, { collectionId, galleryId, photoIndex: actualIndex + 1 });
        break; // Exit if paused
      }
    }
    
    // Ensure all photos were processed before returning
    // The processedCount should equal startPhotoIndex + photosToProcess.length
    const expectedProcessedCount = startPhotoIndex + photosToProcess.length;
    if (processedCount < expectedProcessedCount && onPhotoComplete) {
      // Update to final count if progress callback didn't fire for all items
      processedCount = expectedProcessedCount;
      onPhotoComplete(processedCount);
    }
    
    return { success: true, photoCount: successCount, failedImages };
  } catch (error) {
    if ((error as Error).message === "unauthorized") {
      throw error; // Re-throw to handle at higher level
    }
    logger.error(`${LOGGER_TAG} gallery ${galleryId} failed`, error as Record<string, unknown>);
    return { success: false, photoCount: 0, failedImages: [] };
  }
}

/**
 * Processes a single collection: creates album and processes all galleries
 */
async function processCollection(
  collectionId: number,
  collectionName: string,
  username: string,
  collectionMetadata: Record<string, unknown>,
  galleries: Array<{ id: number; name: string; photo_count: number }>,
  onPhotoComplete?: (currentPhotoInCollection: number) => void,
  pauseState?: PauseState,
  concurrency: number = 1
): Promise<{ success: boolean; galleryCount: number; totalPhotos: number; successfulPhotos: number; failedImages: Array<{ id: string; name: string }>; paused?: boolean }> {
  // Create backend album
  let albumId: string | undefined;
  try {
    const backendResponse = await createPixiesetAlbum(collectionName, collectionMetadata, username, collectionId.toString());
    
    if (!backendResponse.success) {
      logger.error(`${LOGGER_TAG} backend API failed for collection ${collectionId}`, backendResponse);
      return { success: false, galleryCount: 0, totalPhotos: 0, successfulPhotos: 0, failedImages: [] };
    }
    
    albumId = backendResponse.albumId;
    logger.info(`${LOGGER_TAG} backend album created for collection ${collectionId}`, backendResponse);
  } catch (error) {
    logger.error(`${LOGGER_TAG} backend API error for collection ${collectionId}`, error as Record<string, unknown>);
    return { success: false, galleryCount: 0, totalPhotos: 0, successfulPhotos: 0, failedImages: [] };
  }

  // Calculate total photos in this collection
  let totalPhotosInCollection = 0;
  for (const gallery of galleries) {
    totalPhotosInCollection += gallery.photo_count;
  }

  // Process each gallery
  let processedGalleries = 0;
  // Initialize processedPhotos based on pause state (photos already processed in previous galleries)
  let processedPhotos = 0;
  if (pauseState && pauseState.collectionId === collectionId && pauseState.galleryId !== undefined) {
    // Calculate photos already processed in galleries before the paused gallery
    for (const gallery of galleries) {
      if (gallery.id < pauseState.galleryId) {
        processedPhotos += gallery.photo_count;
      } else if (gallery.id === pauseState.galleryId && pauseState.photoIndex !== undefined) {
        // Add photos processed in the paused gallery
        processedPhotos += pauseState.photoIndex;
        break;
      }
    }
  }
  let successfulPhotos = 0; // Track only successfully uploaded photos for summary
  const allFailedImages: Array<{ id: string; name: string }> = []; // Track all failed images in this collection
  
  for (const gallery of galleries) {
    // Check if we should skip this gallery based on pause state
    if (pauseState && pauseState.collectionId === collectionId && pauseState.galleryId !== undefined && pauseState.galleryId > gallery.id) {
      // Gallery was already processed before pause, skip it
      continue;
    }
    
    try {
      // Track the base count before processing this gallery
      const photosBeforeThisGallery = processedPhotos;
      
      const result = await processGallery(
        gallery.id, 
        collectionId, 
        collectionName, 
        username,
        (photosInThisGallery) => {
          // photosInThisGallery is the count within this gallery (1-indexed, accounts for resume)
          // Add it to the base count to get total photos processed in collection
          processedPhotos = photosBeforeThisGallery + photosInThisGallery;
          // Call the callback to update global progress
          if (onPhotoComplete) {
            onPhotoComplete(processedPhotos);
          }
        },
        pauseState, // Pass pause state to processGallery
        albumId, // Pass albumId to processGallery
        concurrency // Pass concurrency to processGallery
      );
      
      // After gallery completes, update processedPhotos to final count
      // This ensures we have the correct count even if callback wasn't called for all photos
      if (result.success) {
        // Gallery completed, so all photos in it are processed
        processedPhotos = photosBeforeThisGallery + gallery.photo_count;
      }
      
      // Check if paused after gallery processing
      if (await stateStore.isPaused()) {
        // Return early with current progress, but indicate we were paused
        return { success: false, galleryCount: processedGalleries, totalPhotos: processedPhotos, successfulPhotos, failedImages: allFailedImages, paused: true };
      }
      if (result.success) {
        processedGalleries++;
        // Add successful photos from this gallery to the total
        successfulPhotos += result.photoCount;
        // Collect failed images from this gallery
        allFailedImages.push(...result.failedImages);
      }
      
      // Wait 0.5 seconds between gallery API calls
      await sleep(500);
    } catch (error) {
      if ((error as Error).message === "unauthorized") {
        throw error; // Re-throw to handle at higher level
      }
      logger.error(`${LOGGER_TAG} gallery ${gallery.id} processing failed`, error as Record<string, unknown>);
      // Continue with next gallery even if one fails
    }
  }

  // Check one more time if paused before returning success
  if (await stateStore.isPaused()) {
    return { success: false, galleryCount: processedGalleries, totalPhotos: processedPhotos, successfulPhotos, failedImages: allFailedImages, paused: true };
  }

  return { success: true, galleryCount: processedGalleries, totalPhotos: processedPhotos, successfulPhotos, failedImages: allFailedImages };
}

/** Result shape from processCollection for migration summary updates */
type ProcessCollectionResult = Awaited<ReturnType<typeof processCollection>>;

/** If migration was completed, reset state for a fresh run */
async function resetCompletedMigrationForFreshStart(profile: { migrationStatus?: string } | null): Promise<void> {
  if (profile?.migrationStatus !== "completed") return;
  logger.info(`${LOGGER_TAG} Resetting completed migration for fresh start`);
  await stateStore.resetCollectionsStatus();
  await stateStore.resetProfileMigration();
}

/** Fetch dashboard, ensure logged in, sync collections. Returns success or failure reason */
async function validateDashboardAndSyncCollections(): Promise<
  { success: true; dashboard: DashboardResponse } | { success: false; reason: string }
> {
  const dashboard = await fetchDashboard(1);
  if (!dashboard.loggedIn) {
    return { success: false, reason: "collectionsFetchFailed" };
  }
  await stateStore.syncCollections(
    dashboard.collections.map((c) => ({ id: c.id, name: c.name }))
  );
  return { success: true, dashboard };
}

/** Resolve selected collection IDs from message (all / selected / pending) and set pending in store */
async function getSelectedCollectionIds(
  message: { all?: boolean; selected?: number[] }
): Promise<number[]> {
  const selectedIds = message.all
    ? (await stateStore.getCollections()).map((c) => c.id)
    : message.selected?.length
      ? message.selected
      : (await stateStore.getPendingCollections()).map((c) => c.id);
  await stateStore.setPending(selectedIds, !message.all);
  return selectedIds;
}

/** Fetch photo count per collection and total across selected collections */
async function loadCollectionPhotoCounts(
  selectedIds: number[]
): Promise<{ collectionPhotoCounts: Map<number, number>; totalPhotos: number }> {
  const collectionPhotoCounts = new Map<number, number>();
  let totalPhotos = 0;
  for (const id of selectedIds) {
    try {
      const detail = await fetchCollectionDetail(id);
      const galleries = detail?.data?.galleries ?? [];
      const photoCount = galleries.reduce((sum, g) => sum + g.photo_count, 0);
      collectionPhotoCounts.set(id, photoCount);
      totalPhotos += photoCount;
    } catch (error) {
      logger.warn(`${LOGGER_TAG} Could not fetch photo count for collection ${id}`, error as Record<string, unknown>);
      collectionPhotoCounts.set(id, 0);
    }
  }
  return { collectionPhotoCounts, totalPhotos };
}

/** Build or update migration summary from profile (handles elapsed time across runs) */
function getOrInitializeMigrationSummary(
  profile: { summary?: MigrationSummary } | null
): MigrationSummary {
  let summary: MigrationSummary = profile?.summary ?? {
    totalCollections: 0,
    totalGalleries: 0,
    totalImages: 0,
    failedCollections: [],
    failedImagesByCollection: []
  };
  if (summary.elapsedTime !== undefined) {
    summary.totalElapsedTime = (summary.totalElapsedTime ?? 0) + summary.elapsedTime;
    summary.startTime = Date.now();
    summary.elapsedTime = undefined;
    summary.endTime = undefined;
    summary.pausedDuration = 0;
    summary.lastPauseStartTime = undefined;
  } else if (!summary.startTime) {
    summary.startTime = Date.now();
    summary.pausedDuration = 0;
  }
  return summary;
}

/** Compute current photo index for progress (from completed collections or pause state) */
async function computeResumePhotoIndex(
  selectedIds: number[],
  collectionPhotoCounts: Map<number, number>,
  pauseState: PauseState | undefined,
  allCollections: Array<{ id: number; status: string }>
): Promise<number> {
  let currentPhotoIndex = 0;
  if (pauseState?.collectionId !== undefined) {
    for (const id of selectedIds) {
      if (id < pauseState.collectionId) {
        currentPhotoIndex += collectionPhotoCounts.get(id) ?? 0;
      } else if (id === pauseState.collectionId) {
        try {
          const detail = await fetchCollectionDetail(id);
          const galleries = detail?.data?.galleries ?? [];
          let photosProcessedInCollection = 0;
          for (const gallery of galleries) {
            if (pauseState.galleryId !== undefined && gallery.id < pauseState.galleryId) {
              photosProcessedInCollection += gallery.photo_count;
            } else if (
              pauseState.galleryId !== undefined &&
              gallery.id === pauseState.galleryId &&
              pauseState.photoIndex !== undefined
            ) {
              photosProcessedInCollection += pauseState.photoIndex;
              break;
            }
          }
          currentPhotoIndex += photosProcessedInCollection;
        } catch (error) {
          logger.warn(`${LOGGER_TAG} Could not calculate resume photo count for collection ${id}`, error as Record<string, unknown>);
        }
        break;
      } else {
        break;
      }
    }
  } else {
    for (const id of selectedIds) {
      const collection = allCollections.find((c) => c.id === id);
      if (collection?.status === "completed") {
        currentPhotoIndex += collectionPhotoCounts.get(id) ?? 0;
      }
    }
  }
  return currentPhotoIndex;
}

/** True if this collection was already completed before pause (should skip when resuming) */
function shouldSkipCollectionBecauseCompletedBeforePause(
  id: number,
  pauseState: PauseState | undefined,
  allCollections: Array<{ id: number; status: string }>
): boolean {
  if (!pauseState || pauseState.collectionId === undefined) return false;
  const collection = allCollections.find((c) => c.id === id);
  return id < pauseState.collectionId && collection?.status === "completed";
}

/** Notify UI that migration has started (or resumed) */
function notifyMigrationStarted(
  selectedIds: number[],
  completedCount: number,
  totalPhotos: number,
  currentPhotoIndex: number,
  isResuming: boolean
): void {
  const percent = totalPhotos > 0 ? Math.min(100, Math.round((currentPhotoIndex / totalPhotos) * 100)) : 0;
  chrome.runtime.sendMessage({
    type: "migrationStarted",
    total: selectedIds.length,
    completed: completedCount,
    totalPhotos,
    currentPhotoIndex,
    percent,
    isResuming
  });
}

/** Signal migration abort to UI (sendMessage + respondOnce). Caller must await stateStore.setPaused(true) and set paused. */
function signalMigrationAbort(
  reason: string,
  respondOnce: (payload: unknown) => void,
  payload: unknown
): void {
  chrome.runtime.sendMessage({ type: "migrationPaused", reason });
  respondOnce(payload);
}

/** Update summary after processing one collection (success or full failure) */
function updateSummaryAfterCollection(
  summary: MigrationSummary,
  collectionId: number,
  result: ProcessCollectionResult | null,
  galleryCount: number,
  allCollections: Array<{ id: number; name: string }>,
  success: boolean
): void {
  if (success && result) {
    summary.totalCollections += 1;
    summary.totalGalleries += galleryCount;
    summary.totalImages += result.successfulPhotos ?? 0;
    const failedImages = result.failedImages ?? [];
    if (failedImages.length > 0) {
      let failureInfo = summary.failedImagesByCollection.find((f) => f.collectionId === collectionId);
      if (!failureInfo) {
        const collectionName = allCollections.find((c) => c.id === collectionId)?.name ?? `Collection ${collectionId}`;
        failureInfo = {
          collectionId,
          collectionName,
          failedImageCount: 0,
          failedImages: []
        };
        summary.failedImagesByCollection.push(failureInfo);
      }
      failureInfo.failedImageCount += failedImages.length;
      if (failureInfo.failedImageCount < 3) {
        failureInfo.failedImages.push(...failedImages);
      } else {
        failureInfo.failedImages = [];
      }
    }
  } else {
    if (!summary.failedCollections.includes(collectionId)) {
      summary.failedCollections.push(collectionId);
    }
  }
}

/** Finalize migration after loop: mark completed or update elapsed time if paused/aborted */
async function finalizeMigrationAfterLoop(
  aborted: boolean,
  selectedIds: number[],
  message: { all?: boolean },
  respondOnce: (payload: unknown) => void
): Promise<void> {
  const isPaused = await stateStore.isPaused();
  if (!aborted && !isPaused) {
    const finalCollections = await stateStore.getCollections();
    const allCompleted = selectedIds.every((id) => {
      const c = finalCollections.find((col) => col.id === id);
      return c?.status === "completed";
    });
    const finalProfile = await stateStore.loadAnyProfile();
    const hasProgress =
      finalProfile?.summary &&
      ((finalProfile.summary.totalCollections > 0) ||
        (finalProfile.summary.totalGalleries > 0) ||
        (finalProfile.summary.totalImages > 0));

    if (allCompleted && hasProgress) {
      const finalSummary = finalProfile?.summary;
      if (finalSummary?.startTime) {
        const now = Date.now();
        let totalPausedDuration = finalSummary.pausedDuration ?? 0;
        if (finalSummary.lastPauseStartTime) {
          totalPausedDuration += now - finalSummary.lastPauseStartTime;
        }
        finalSummary.endTime = now;
        finalSummary.elapsedTime = now - finalSummary.startTime - totalPausedDuration;
        finalSummary.lastPauseStartTime = undefined;
        await stateStore.updateSummary(finalSummary);
      }
      await stateStore.updateProfileStatus("completed");
      await stateStore.clearPauseState();
      chrome.runtime.sendMessage({ type: "migrationCompleted" });
      respondOnce({ success: true, processed: selectedIds, all: message.all ?? false });
    } else {
      logger.info(
        `${LOGGER_TAG} Migration loop ended but conditions not met for completion. allCompleted: ${allCompleted}, hasProgress: ${hasProgress}`
      );
      respondOnce({ success: false, reason: "incomplete" });
    }
  } else {
    if (isPaused) {
      const finalProfile = await stateStore.loadAnyProfile();
      const finalSummary = finalProfile?.summary;
      if (finalSummary?.startTime) {
        const now = Date.now();
        let totalPausedDuration = finalSummary.pausedDuration ?? 0;
        if (finalSummary.lastPauseStartTime) {
          totalPausedDuration += now - finalSummary.lastPauseStartTime;
        }
        finalSummary.elapsedTime = now - finalSummary.startTime - totalPausedDuration;
        await stateStore.updateSummary(finalSummary);
      }
      logger.info(`${LOGGER_TAG} Migration paused, not marking as completed`);
    } else if (aborted) {
      logger.info(`${LOGGER_TAG} Migration aborted, not marking as completed`);
    }
  }
}

/** Orchestrates the full migration: setup, loop over collections, finalization */
async function runStartMigration(
  message: Extract<BackgroundMessage, { type: "startMigration" }>,
  sendResponse: (response: unknown) => void,
  concurrency: number
): Promise<void> {
  await stateStore.setPaused(false);
  let responded = false;
  const respondOnce = (payload: unknown) => {
    if (responded) return;
    responded = true;
    sendResponse(payload);
  };

  const profile = await stateStore.loadAnyProfile() ?? null;
  await resetCompletedMigrationForFreshStart(profile);

  const dashboardResult = await validateDashboardAndSyncCollections();
  if (!dashboardResult.success) {
    await stateStore.setPaused(true);
    chrome.runtime.sendMessage({ type: "migrationPaused", reason: dashboardResult.reason });
    respondOnce({ success: false, reason: dashboardResult.reason });
    return;
  }

  const selectedIds = await getSelectedCollectionIds(message);
  await stateStore.updateProfileStatus("in_progress");

  const pauseState = await stateStore.getPauseState();
  if (pauseState) {
    logger.info(`${LOGGER_TAG} Resuming from pause state: collection ${pauseState.collectionId}, gallery ${pauseState.galleryId}, photo ${pauseState.photoIndex}`);
  }

  const allCollections = await stateStore.getCollections();
  const completedCount = allCollections.filter((c) => c.status === "completed").length;
  const { collectionPhotoCounts, totalPhotos } = await loadCollectionPhotoCounts(selectedIds);
  let summary = getOrInitializeMigrationSummary(profile ?? null);
  let currentPhotoIndex = await computeResumePhotoIndex(selectedIds, collectionPhotoCounts, pauseState, allCollections);
  let currentCollectionIndex = completedCount;
  const isResuming = pauseState !== undefined && pauseState.collectionId !== undefined;

  notifyMigrationStarted(selectedIds, completedCount, totalPhotos, currentPhotoIndex, isResuming);

  let aborted = false;
  for (const id of selectedIds) {
    if (shouldSkipCollectionBecauseCompletedBeforePause(id, pauseState, allCollections)) continue;

    if (await stateStore.isPaused()) {
      paused = true;
      await stateStore.setPaused(true);
      signalMigrationAbort("user", respondOnce, { success: false, reason: "paused" });
      aborted = true;
      return;
    }

    await stateStore.updateStatus(id, "in_progress");
    logger.info(`${LOGGER_TAG} migrating collection ${id}`);

    let detail: Awaited<ReturnType<typeof fetchCollectionDetail>>;
    try {
      detail = await fetchCollectionDetail(id);
    } catch (error) {
      if ((error as Error).message === "unauthorized") {
        paused = true;
        await stateStore.setPaused(true);
        await stateStore.updateProfileStatus("in_progress");
        signalMigrationAbort("unauthorized", respondOnce, { success: false, reason: "unauthorized" });
        aborted = true;
        return;
      }
      logger.error(`${LOGGER_TAG} collection ${id} failed`, error as Record<string, unknown>);
      await stateStore.updateStatus(id, "failed", (error as Error).message);
      continue;
    }

    const galleryCount = detail?.data?.galleries?.length ?? 0;
    logger.info(`${LOGGER_TAG} collection ${id} has ${galleryCount} galleries`);
    chrome.runtime.sendMessage({
      type: "migrationProgress",
      collectionId: id,
      status: "in_progress",
      galleryCount,
      name: detail?.data?.collection?.name
    });

    const collectionName = detail?.data?.collection?.name ?? `Collection ${id}`;
    const username = profile?.username ?? "";
    const collectionMetadata = detail?.data?.collection ?? {};
    const galleries = detail?.data?.galleries ?? [];
    const totalPhotosInCollection = collectionPhotoCounts.get(id) ?? 0;
    const collectionStartPhotoIndex = currentPhotoIndex;

    let result: ProcessCollectionResult | null = null;
    let collectionProcessingComplete = false;
    try {
      result = await processCollection(
        id,
        collectionName,
        username,
        collectionMetadata,
        galleries,
        (currentPhotoInCollection) => {
          if (collectionProcessingComplete) return;
          const newGlobalIndex = collectionStartPhotoIndex + currentPhotoInCollection;
          if (newGlobalIndex > currentPhotoIndex) currentPhotoIndex = newGlobalIndex;
          const percent = totalPhotos > 0 ? Math.min(100, Math.round((currentPhotoIndex / totalPhotos) * 100)) : 0;
          chrome.runtime.sendMessage({
            type: "migrationProgress",
            collectionId: id,
            collectionName,
            status: "in_progress",
            currentPhoto: currentPhotoInCollection,
            totalPhotosInCollection,
            currentPhotoIndex,
            totalPhotos,
            percent,
            collectionIndex: currentCollectionIndex,
            totalCollections: selectedIds.length
          });
        },
        pauseState,
        concurrency
      );
      collectionProcessingComplete = true;
      const expectedFinalIndex = collectionStartPhotoIndex + totalPhotosInCollection;
      if (currentPhotoIndex < expectedFinalIndex) currentPhotoIndex = expectedFinalIndex;

      if (!result.success) {
        if (result.paused) {
          paused = true;
          await stateStore.setPaused(true);
          signalMigrationAbort("user", respondOnce, { success: false, reason: "paused" });
          aborted = true;
          return;
        }
        await stateStore.updateStatus(id, "failed", "Collection processing failed");
        continue;
      }

      if (await stateStore.isPaused()) {
        paused = true;
        await stateStore.setPaused(true);
        signalMigrationAbort("user", respondOnce, { success: false, reason: "paused" });
        aborted = true;
        return;
      }
    } catch (error) {
      if ((error as Error).message === "unauthorized") {
        paused = true;
        await stateStore.setPaused(true);
        await stateStore.updateProfileStatus("in_progress");
        signalMigrationAbort("unauthorized", respondOnce, { success: false, reason: "unauthorized" });
        aborted = true;
        return;
      }
      logger.error(`${LOGGER_TAG} collection ${id} processing failed`, error as Record<string, unknown>);
      await stateStore.updateStatus(id, "failed", (error as Error).message);
      continue;
    }

    if (await stateStore.isPaused()) {
      paused = true;
      await stateStore.setPaused(true);
      signalMigrationAbort("user", respondOnce, { success: false, reason: "paused" });
      aborted = true;
      return;
    }

    const collectionSucceeded = result !== null && result.success;
    if (collectionSucceeded) {
      await stateStore.updateStatus(id, "completed");
    } else {
      await stateStore.updateStatus(id, "failed");
    }
    updateSummaryAfterCollection(summary, id, result, galleryCount, allCollections, collectionSucceeded);
    await stateStore.updateSummary(summary);
    currentCollectionIndex++;

    const percent = totalPhotos > 0 ? Math.min(100, Math.round((currentPhotoIndex / totalPhotos) * 100)) : 100;
    chrome.runtime.sendMessage({
      type: "migrationProgress",
      collectionId: id,
      collectionName: detail?.data?.collection?.name ?? `Collection ${id}`,
      status: "completed",
      currentPhotoIndex,
      totalPhotos,
      percent,
      collectionIndex: currentCollectionIndex,
      totalCollections: selectedIds.length
    });
  }

  await finalizeMigrationAfterLoop(aborted, selectedIds, message, respondOnce);
}

type BackgroundMessage =
  | { type: "bootstrap" }
  | { type: "fetchCollections"; page?: number }
  | { type: "getAllCollections" }
  | { type: "startMigration"; selected?: number[]; all?: boolean; concurrency?: number }
  | { type: "pauseMigration" }
  | { type: "profileStatus" };

let paused = true;

chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
  if (message.type === "profileStatus") {
    stateStore.loadAnyProfile().then(async (profile) => {
      if (!profile) {
        sendResponse({ loggedIn: false });
        return;
      }

      let responded = false;
      const respondOnce = (payload: unknown) => {
        if (responded) {
          return;
        }

        responded = true;
        sendResponse(payload);
      };

      try {
        // Fetch first page to get total count
        const dashboard = await fetchDashboard(1);
        if (!dashboard.loggedIn) {
          respondOnce({ loggedIn: false });
          return;
        }

        const totalFromAPI = dashboard.meta?.total ?? 0;
        const existingCollections = await stateStore.getCollections();
        const existingCount = existingCollections.length;

        // If we don't have all collections, fetch all pages
        if (totalFromAPI > existingCount) {
          logger.info(`${LOGGER_TAG} Fetching all ${totalFromAPI} collections (have ${existingCount})`);
          let page = 1;
          let hasMore = true;
          const lastPage = dashboard.meta?.last_page ?? 1;

          // Sync first page
          await stateStore.syncCollections(dashboard.collections.map((collection) => ({ id: collection.id, name: collection.name })));

          // Fetch remaining pages
          while (page < lastPage) {
            page++;
            const nextDashboard = await fetchDashboard(page);
            if (nextDashboard.loggedIn && nextDashboard.collections.length > 0) {
              await stateStore.syncCollections(nextDashboard.collections.map((collection) => ({ id: collection.id, name: collection.name })));
            }
          }
        } else {
          // Just sync first page to ensure we have latest data
          await stateStore.syncCollections(dashboard.collections.map((collection) => ({ id: collection.id, name: collection.name })));
        }

        const collections = await stateStore.getCollections();
        const total = dashboard.meta?.total ?? collections.length;
        const completed = collections.filter((record) => record.status === "completed").length;
        
        // Calculate photo-level progress if migration is in progress
        // Use summary data if available (much faster than fetching all collection details)
        let currentPhotoIndex = 0;
        let totalPhotos = 0;
        let percent = 0;
        
        if (profile.migrationStatus === "in_progress") {
          const pauseState = await stateStore.getPauseState();
          const summary = profile.summary;
          
          // Use summary.totalImages as a baseline (photos successfully uploaded)
          // This is much faster than fetching all collection details
          if (summary) {
            currentPhotoIndex = summary.totalImages ?? 0;
          }
          
          // For total photos, we can estimate or use a cached value
          // For now, we'll use a simple approach: only fetch if we really need it
          // But to avoid slow loading, we'll use collection-level progress as fallback
          // The actual photo-level progress will be updated via migrationProgress messages
          
          // Calculate percent based on collections if we don't have photo-level data
          if (total === 0) {
            percent = 0;
          } else {
            // Use collection-level progress as approximation (much faster)
            percent = Math.round((completed / total) * 100);
          }
          
          // If we have pause state, we can provide more accurate progress
          // But avoid expensive API calls here - let the migration loop handle it
        }
        
        respondOnce({
          loggedIn: true,
          profile,
          total,
          completed,
          currentPhotoIndex,
          totalPhotos,
          percent
        });
      } catch (error) {
        logger.error(`${LOGGER_TAG} profileStatus failed`, error as Record<string, unknown>);
        respondOnce({
          loggedIn: false,
          status: 0,
          error: (error as Error).message
        });
      }
    });
    return true;
  }

  if (message.type === "pauseMigration") {
    paused = true;
    logger.info("Popup requested migration pause");
    (async () => {
      // Get current pause state (will be set by the migration loop)
      const pauseState = await stateStore.getPauseState();
      await stateStore.setPaused(true, pauseState);
      chrome.runtime.sendMessage({ type: "migrationPaused", reason: "user" });
      sendResponse({ paused });
    })();
    return true;
  }

  if (message.type === "bootstrap") {
    paused = false;
    fetchBootstrap()
      .then(async (response) => {
      if (response.loggedIn) {
        const previous = await stateStore.loadProfile(response.email);
        if (!previous) {
          await stateStore.saveProfile({
            username: response.username,
            email: response.email,
            businessName: response.businessName,
            paused: false,
            migrationStatus: "not_started"
          });
        } else if (previous.migrationStatus === "not_started") {
          // keep existing status but update business info if changed
          await stateStore.saveProfile({
            username: response.username,
            email: response.email,
            businessName: response.businessName,
            paused: false,
            migrationStatus: previous.migrationStatus
          });
        }
        const existingCollections = await stateStore.getCollections();
        if (!existingCollections.length) {
          // Fetch all pages on initial bootstrap
          const dashboard = await fetchDashboard(1);
          if (dashboard.loggedIn) {
            await stateStore.syncCollections(dashboard.collections.map((collection) => ({ id: collection.id, name: collection.name })));
            const totalFromAPI = dashboard.meta?.total ?? 0;
            const lastPage = dashboard.meta?.last_page ?? 1;
            
            // Fetch remaining pages
            for (let page = 2; page <= lastPage; page++) {
              const nextDashboard = await fetchDashboard(page);
              if (nextDashboard.loggedIn && nextDashboard.collections.length > 0) {
                await stateStore.syncCollections(nextDashboard.collections.map((collection) => ({ id: collection.id, name: collection.name })));
              }
            }
          }
        }
      }
      sendResponse(response);
      })
      .catch((error) => {
        logger.error(`${LOGGER_TAG} bootstrap failed`, error as Record<string, unknown>);
        sendResponse({ loggedIn: false, status: 0, error: (error as Error).message });
      });
    return true;
  }

  if (message.type === "fetchCollections") {
    paused = false;
    fetchDashboard(message.page ?? 1)
      .then(async (response) => {
      if (response.loggedIn) {
        await stateStore.syncCollections(response.collections.map((collection) => ({ id: collection.id, name: collection.name })));
      }
      sendResponse(response);
      })
      .catch((error) => {
        logger.error(`${LOGGER_TAG} dashboard failed`, error as Record<string, unknown>);
        sendResponse({ loggedIn: false, status: 0, error: (error as Error).message });
      });
    return true;
  }

  if (message.type === "getAllCollections") {
    (async () => {
      try {
        // Fetch all pages and sync all collections
        let page = 1;
        let hasMore = true;
        const allCollections: Array<{ id: number; name: string; coverPhotoThumbnail?: string; photo_count?: number }> = [];

        while (hasMore) {
          const dashboard = await fetchDashboard(page);
          if (!dashboard.loggedIn) {
            sendResponse({ loggedIn: false, status: dashboard.status });
            return;
          }

          await stateStore.syncCollections(dashboard.collections.map((collection) => ({ id: collection.id, name: collection.name })));
          allCollections.push(...dashboard.collections);

          const lastPage = dashboard.meta?.last_page ?? 1;
          hasMore = page < lastPage;
          page++;
        }

        // Get all collections from IndexedDB with their statuses
        const dbCollections = await stateStore.getCollections();
        const dbMap = new Map(dbCollections.map((c) => [c.id, c]));
        
        // Merge API data with DB statuses
        const merged = allCollections.map((apiCol) => {
          const dbCol = dbMap.get(apiCol.id);
          return {
            id: apiCol.id,
            name: apiCol.name,
            coverPhotoThumbnail: apiCol.coverPhotoThumbnail,
            photo_count: apiCol.photo_count,
            status: dbCol?.status ?? "not_selected"
          };
        });

        sendResponse({ loggedIn: true, collections: merged, total: allCollections.length });
      } catch (error) {
        logger.error(`${LOGGER_TAG} getAllCollections failed`, error as Record<string, unknown>);
        sendResponse({ loggedIn: false, status: 0, error: (error as Error).message });
      }
    })();
    return true;
  }

  if (message.type === "startMigration") {
    paused = false;
    const concurrency = Math.max(1, Math.min(20, message.concurrency ?? 1));
    logger.info(`${LOGGER_TAG} Starting migration with concurrency factor: ${concurrency}`);
    runStartMigration(message, sendResponse, concurrency);
    return true;
  }

  return false;
});

