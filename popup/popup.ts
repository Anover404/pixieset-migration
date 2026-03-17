/**
 * Popup script gates the migration experience: bootstrap, display user info, then
 * let the user choose between migrating everything or selecting specific collections.
 */

type CollectionSummary = {
  id: number;
  name: string;
  coverPhoto?: string;
  coverPhotoThumbnail?: string;
  photo_count?: number;
};

type PaginationMeta = {
  total?: number;
  current_page?: number;
  last_page?: number;
};

type DashboardResponseSuccess = {
  loggedIn: true;
  count: number;
  status: number;
  collections: CollectionSummary[];
  meta: PaginationMeta;
};

type DashboardResponseFailure = {
  loggedIn: false;
  status: number;
  error?: string;
};

type DashboardResponse = DashboardResponseSuccess | DashboardResponseFailure;

type BootstrapResponseSuccess = {
  loggedIn: true;
  username: string;
  email: string;
  businessName?: string;
  status: number;
};

type BootstrapResponseFailure = {
  loggedIn: false;
  status: number;
  error?: string;
};

import { ProfileRecord } from "../background/models.js";

type BootstrapResponse = BootstrapResponseSuccess | BootstrapResponseFailure;

type DisplayProfile = {
  username: string;
  email: string;
  businessName?: string;
};

const COLLECTION_NAME_MAX_LENGTH = 25;

function truncateCollectionName(name: string, maxLen: number = COLLECTION_NAME_MAX_LENGTH): string {
  if (name.length <= maxLen) return name;
  return name.slice(0, maxLen) + "...";
}

const statusEl = document.getElementById("status") as HTMLParagraphElement | null;
const userInfoEl = document.getElementById("userInfo") as HTMLParagraphElement | null;
const countEl = document.getElementById("totalCount") as HTMLParagraphElement | null;
const progressEl = document.getElementById("progressInfo") as HTMLParagraphElement | null;
const loginButton = document.getElementById("login") as HTMLButtonElement | null;
const heroLoginBtn = document.getElementById("heroLoginBtn") as HTMLButtonElement | null;
const heroLogin = document.getElementById("heroLogin") as HTMLDivElement | null;
const selectButton = document.getElementById("selectCollections") as HTMLButtonElement | null;
const migrateAllButton = document.getElementById("migrateAll") as HTMLButtonElement | null;
const loginView = document.getElementById("loginView") as HTMLDivElement | null;
const startView = document.getElementById("startView") as HTMLDivElement | null;
const progressView = document.getElementById("progressView") as HTMLDivElement | null;
const mainActions = document.getElementById("mainActions") as HTMLDivElement | null;
const activeActions = document.getElementById("activeActions") as HTMLDivElement | null;
const pauseButton = document.getElementById("pause") as HTMLButtonElement | null;
const resumeButton = document.getElementById("resume") as HTMLButtonElement | null;
const loader = document.getElementById("migrationLoader") as HTMLDivElement | null;
const loaderPercent = document.getElementById("loaderPercent") as HTMLParagraphElement | null;
const loaderCollection = document.getElementById("loaderCollection") as HTMLParagraphElement | null;
const selectionModal = document.getElementById("selectionModal") as HTMLDivElement | null;
const modalList = document.getElementById("modalList") as HTMLDivElement | null;
const modalStatus = document.getElementById("modalStatus") as HTMLParagraphElement | null;
const modalConfirm = document.getElementById("modalConfirm") as HTMLButtonElement | null;
const modalClose = document.getElementById("modalClose") as HTMLButtonElement | null;
const modalPrev = document.getElementById("modalPrev") as HTMLButtonElement | null;
const modalNext = document.getElementById("modalNext") as HTMLButtonElement | null;
const modalPageInfo = document.getElementById("modalPageInfo") as HTMLSpanElement | null;
const rangeStartInput = document.getElementById("rangeStart") as HTMLInputElement | null;
const rangeEndInput = document.getElementById("rangeEnd") as HTMLInputElement | null;
const selectRangeBtn = document.getElementById("selectRangeBtn") as HTMLButtonElement | null;
const rangeHint = document.getElementById("rangeHint") as HTMLSpanElement | null;
const migrationSummary = document.getElementById("migrationSummary") as HTMLDivElement | null;
const summaryCollections = document.getElementById("summaryCollections") as HTMLSpanElement | null;
const summaryGalleries = document.getElementById("summaryGalleries") as HTMLSpanElement | null;
const summaryImages = document.getElementById("summaryImages") as HTMLSpanElement | null;
const summaryTime = document.getElementById("summaryTime") as HTMLSpanElement | null;
const summaryExpand = document.getElementById("summaryExpand") as HTMLButtonElement | null;
const summaryDetailModal = document.getElementById("summaryDetailModal") as HTMLDivElement | null;
const summaryDetailContent = document.getElementById("summaryDetailContent") as HTMLDivElement | null;
const summaryModalClose = document.getElementById("summaryModalClose") as HTMLButtonElement | null;
const summaryDownload = document.getElementById("summaryDownload") as HTMLButtonElement | null;
const concurrencyFactorInput = document.getElementById("concurrencyFactor") as HTMLInputElement | null;

let modalCurrentPage = 1;
let modalMeta: PaginationMeta = {};
let modalCollections: CollectionSummary[] = [];
let selectedIds = new Set<number>();
let isLoggedIn = false;
let migrationActive = false;
let totalCollections = 0;
let processedCollections = 0;
let lastMigrationOptions: { all?: boolean; selected?: number[]; concurrency?: number } = {};

const updateStatus = (text: string) => {
  if (statusEl) {
    statusEl.textContent = text;
    // Add completed class for green styling
    if (text.toLowerCase().includes("completed")) {
      statusEl.classList.add("completed");
    } else {
      statusEl.classList.remove("completed");
    }
  }
};


const updateProgress = (text: string) => {
  if (progressEl) {
    progressEl.textContent = text;
  }
};

const updateUserInfo = (user: DisplayProfile) => {
  if (!userInfoEl) {
    return;
  }

  const business = user.businessName ? ` • ${user.businessName}` : "";
  userInfoEl.textContent = `${user.username}${business} — ${user.email}`;
};

const updateCount = (value?: number) => {
  if (countEl) {
    countEl.textContent = value ? `${value} collections available` : "";
  }
};

type MigrationSummary = {
  totalCollections: number;
  totalGalleries: number;
  totalImages: number;
  failedCollections?: number[];
  failedImagesByCollection?: Array<{
    collectionId: number;
    collectionName: string;
    failedImageCount: number;
    failedImages?: Array<{ id: string; name: string; reason?: string }>;
  }>;
  startTime?: number;
  pausedDuration?: number;
  lastPauseStartTime?: number;
  endTime?: number;
  elapsedTime?: number;
  totalElapsedTime?: number;
};

/**
 * Formats elapsed time in milliseconds to a human-readable string
 * @param elapsedMs - Elapsed time in milliseconds
 * @returns Formatted string like "2h 15m 30s" or "45m 12s" or "30s"
 */
const formatElapsedTime = (elapsedMs: number | undefined): string => {
  if (!elapsedMs || elapsedMs < 0) {
    return "-";
  }
  
  const seconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  const remainingSeconds = seconds % 60;
  const remainingMinutes = minutes % 60;
  
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (remainingMinutes > 0 || hours > 0) {
    parts.push(`${remainingMinutes}m`);
  }
  if (remainingSeconds > 0 || parts.length === 0) {
    parts.push(`${remainingSeconds}s`);
  }
  
  return parts.join(" ");
};

/**
 * Calculates current elapsed time (cumulative across all runs, excluding idle time between runs)
 * @param summary - Migration summary with time tracking
 * @returns Elapsed time in milliseconds, or undefined if not started
 */
const calculateCurrentElapsedTime = (summary: MigrationSummary): number | undefined => {
  const baseMs = summary.totalElapsedTime ?? 0;

  // Completed run: use stored elapsedTime for this run
  if (summary.elapsedTime !== undefined) {
    const total = baseMs + summary.elapsedTime;
    return total > 0 ? total : undefined;
  }

  // In progress: add current run duration
  if (summary.startTime) {
    const now = Date.now();
    let totalPausedDuration = summary.pausedDuration ?? 0;
    if (summary.lastPauseStartTime) {
      totalPausedDuration += now - summary.lastPauseStartTime;
    }
    const total = baseMs + (now - summary.startTime - totalPausedDuration);
    return total > 0 ? total : undefined;
  }

  return baseMs > 0 ? baseMs : undefined;
};

const updateSummary = (summary?: MigrationSummary) => {
  if (!summary) {
    migrationSummary?.classList.add("hidden");
    return;
  }

  if (summaryCollections) {
    summaryCollections.textContent = summary.totalCollections.toString();
  }
  if (summaryGalleries) {
    summaryGalleries.textContent = summary.totalGalleries.toString();
  }
  if (summaryImages) {
    summaryImages.textContent = summary.totalImages.toString();
  }
  
  // Display time taken
  if (summaryTime) {
    const elapsedTime = calculateCurrentElapsedTime(summary);
    summaryTime.textContent = formatElapsedTime(elapsedTime);
  }
  
  migrationSummary?.classList.remove("hidden");
};

let currentSummary: MigrationSummary | undefined;

const populateSummaryDetail = async (summary: MigrationSummary) => {
  if (!summaryDetailContent) return;
  
  currentSummary = summary;
  
  // Clear existing content
  summaryDetailContent.innerHTML = "";
  
  // Add Time Information Section
  const timeSection = document.createElement("div");
  timeSection.className = "summary-detail-section";
  
  const timeTitle = document.createElement("h3");
  timeTitle.textContent = "Time Information";
  timeSection.appendChild(timeTitle);
  
  const timeInfo = document.createElement("div");
  timeInfo.className = "time-info";
  
  const elapsedTime = calculateCurrentElapsedTime(summary);
  const elapsedTimeFormatted = formatElapsedTime(elapsedTime);
  
  const timeItems = [
    { label: "Total Time", value: elapsedTimeFormatted },
    { label: "Start Time", value: summary.startTime ? new Date(summary.startTime).toLocaleString() : "N/A" },
    { label: "End Time", value: summary.endTime ? new Date(summary.endTime).toLocaleString() : "N/A" },
    { label: "Time Paused", value: formatElapsedTime(summary.pausedDuration) }
  ];
  
  timeItems.forEach(({ label, value }) => {
    const item = document.createElement("div");
    item.className = "time-info-item";
    const labelEl = document.createElement("span");
    labelEl.className = "time-info-label";
    labelEl.textContent = `${label}: `;
    const valueEl = document.createElement("span");
    valueEl.className = "time-info-value";
    valueEl.textContent = value;
    item.appendChild(labelEl);
    item.appendChild(valueEl);
    timeInfo.appendChild(item);
  });
  
  timeSection.appendChild(timeInfo);
  summaryDetailContent.appendChild(timeSection);
  
  // Check if there are any failures
  const hasFailedCollections = summary.failedCollections && summary.failedCollections.length > 0;
  const hasFailedImages = summary.failedImagesByCollection && summary.failedImagesByCollection.length > 0;
  
  if (!hasFailedCollections && !hasFailedImages) {
    const emptySection = document.createElement("div");
    emptySection.className = "summary-detail-section empty";
    emptySection.textContent = "No failures recorded. All migrations completed successfully!";
    summaryDetailContent.appendChild(emptySection);
    return;
  }
  
  // Get collection names for failed collections
  let collectionMap = new Map<number, string>();
  if (hasFailedCollections) {
    try {
      const response = (await chrome.runtime.sendMessage({ type: "getAllCollections" })) as {
        loggedIn: boolean;
        collections?: Array<{ id: number; name: string }>;
      };
      const collections = response?.collections ?? [];
      collectionMap = new Map(collections.map(c => [c.id, c.name]));
    } catch (error) {
      console.error("Failed to fetch collection names", error);
    }
  }
  
  // Failed Collections Section
  if (hasFailedCollections) {
    const failedCollectionsSection = document.createElement("div");
    failedCollectionsSection.className = "summary-detail-section";
    
    const title = document.createElement("h3");
    title.textContent = `Failed Collections (${summary.failedCollections!.length})`;
    failedCollectionsSection.appendChild(title);
    
    const list = document.createElement("div");
    list.className = "failed-collection-list";
    
    summary.failedCollections!.forEach((collectionId) => {
      const item = document.createElement("div");
      item.className = "failed-collection-item";
      const collectionName = collectionMap.get(collectionId) ?? `Collection ${collectionId}`;
      const displayName = truncateCollectionName(collectionName);
      item.textContent = `${displayName} (ID: ${collectionId})`;
      item.title = collectionName;
      list.appendChild(item);
    });
    
    failedCollectionsSection.appendChild(list);
    summaryDetailContent.appendChild(failedCollectionsSection);
  }
  
  // Failed Images by Collection Section
  if (hasFailedImages) {
    const failedImagesSection = document.createElement("div");
    failedImagesSection.className = "summary-detail-section";
    
    const title = document.createElement("h3");
    const totalFailedImages = summary.failedImagesByCollection!.reduce((sum, info) => sum + info.failedImageCount, 0);
    title.textContent = `Failed Images by Collection (${totalFailedImages} total)`;
    failedImagesSection.appendChild(title);
    
    summary.failedImagesByCollection!.forEach((failureInfo) => {
      const collectionInfo = document.createElement("div");
      collectionInfo.className = "collection-failure-info";
      
      const header = document.createElement("div");
      header.className = "collection-failure-header";
      
      const name = document.createElement("div");
      name.className = "collection-failure-name";
      name.textContent = truncateCollectionName(failureInfo.collectionName);
      name.title = failureInfo.collectionName;
      
      const count = document.createElement("div");
      count.className = "collection-failure-count";
      count.textContent = `${failureInfo.failedImageCount} failed`;
      
      header.appendChild(name);
      header.appendChild(count);
      collectionInfo.appendChild(header);
      
      // Show failed image details: all if ≤3, or one sample with reason if >3
      if (failureInfo.failedImages && failureInfo.failedImages.length > 0) {
        const imageList = document.createElement("div");
        imageList.className = "failed-image-list";
        if (failureInfo.failedImageCount > 3) {
          const sampleLabel = document.createElement("div");
          sampleLabel.className = "failed-image-sample-label";
          sampleLabel.textContent = "Sample failure (reason often same for all):";
          imageList.appendChild(sampleLabel);
        }
        failureInfo.failedImages.forEach((failedImage) => {
          const imageItem = document.createElement("div");
          imageItem.className = "failed-image-item";
          
          const imageName = document.createElement("div");
          imageName.className = "failed-image-name";
          imageName.textContent = failedImage.name;
          
          const imageId = document.createElement("div");
          imageId.className = "failed-image-id";
          imageId.textContent = `ID: ${failedImage.id}`;
          
          imageItem.appendChild(imageName);
          imageItem.appendChild(imageId);
          
          // Add failure reason if available
          if (failedImage.reason) {
            const imageReason = document.createElement("div");
            imageReason.className = "failed-image-reason";
            imageReason.textContent = `Reason: ${failedImage.reason}`;
            imageItem.appendChild(imageReason);
          }
          
          imageList.appendChild(imageItem);
        });
        
        collectionInfo.appendChild(imageList);
      }
      
      failedImagesSection.appendChild(collectionInfo);
    });
    
    summaryDetailContent.appendChild(failedImagesSection);
  }
};

const openSummaryDetail = async () => {
  if (!summaryDetailModal || !currentSummary) return;
  await populateSummaryDetail(currentSummary);
  summaryDetailModal.classList.remove("hidden");
  summaryExpand?.classList.add("expanded");
};

const closeSummaryDetail = () => {
  if (!summaryDetailModal) return;
  summaryDetailModal.classList.add("hidden");
  summaryExpand?.classList.remove("expanded");
};

const downloadSummary = () => {
  if (!currentSummary) return;
  
  // Ensure failedImagesByCollection includes failure reasons in the download
  const failedImagesByCollectionWithReasons = currentSummary.failedImagesByCollection?.map((c) => ({
    collectionId: c.collectionId,
    collectionName: c.collectionName,
    failedImageCount: c.failedImageCount,
    failedImages: (c.failedImages ?? []).map((img) => ({
      id: img.id,
      name: img.name,
      ...(img.reason !== undefined && { reason: img.reason })
    }))
  }));

  // Enhance summary with formatted time information and explicit failure reasons
  const enhancedSummary = {
    ...currentSummary,
    failedImagesByCollection: failedImagesByCollectionWithReasons ?? currentSummary.failedImagesByCollection,
    timeInfo: {
      startTime: currentSummary.startTime ? new Date(currentSummary.startTime).toISOString() : undefined,
      endTime: currentSummary.endTime ? new Date(currentSummary.endTime).toISOString() : undefined,
      elapsedTimeMs: calculateCurrentElapsedTime(currentSummary),
      elapsedTimeFormatted: formatElapsedTime(calculateCurrentElapsedTime(currentSummary)),
      pausedDurationMs: currentSummary.pausedDuration,
      pausedDurationFormatted: formatElapsedTime(currentSummary.pausedDuration)
    }
  };

  const dataStr = JSON.stringify(enhancedSummary, null, 2);
  const dataBlob = new Blob([dataStr], { type: "application/json" });
  const url = URL.createObjectURL(dataBlob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `migration-summary-${new Date().toISOString().split("T")[0]}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const toggleLoginButton = (visible: boolean) => {
  loginButton?.classList.toggle("hidden", !visible);
  heroLoginBtn?.classList.toggle("hidden", !visible);
  heroLogin?.classList.toggle("hidden", !visible);
};

const toggleMigrationActions = (enabled: boolean) => {
  [selectButton, migrateAllButton].forEach((el) => {
    if (!el) {
      return;
    }

    if (enabled) {
      el.removeAttribute("disabled");
    } else {
      el.setAttribute("disabled", "true");
    }
  });
};

const refreshProfileStatus = async () => {
  try {
    const response = (await chrome.runtime.sendMessage({ type: "profileStatus" })) as {
      loggedIn: boolean;
      profile?: ProfileRecord & { paused?: boolean };
      total?: number;
      completed?: number;
      currentPhotoIndex?: number;
      totalPhotos?: number;
      percent?: number;
    };

    if (!response.loggedIn || !response.profile) {
      showView("login");
      toggleLoginButton(true);
      return;
    }

    updateUserInfo(response.profile);
    updateCount(response.total);
    
    // Update status with migration status
    if (response.profile.migrationStatus === "completed") {
      updateStatus("Migration completed");
      statusEl?.classList.add("completed");
    } else if (response.profile.migrationStatus === "in_progress") {
      updateStatus("Migration in progress...");
      statusEl?.classList.remove("completed");
    } else {
      updateStatus("Ready to migrate");
      statusEl?.classList.remove("completed");
    }
    toggleLoginButton(false);

    if (response.profile.migrationStatus === "in_progress") {
      totalCollections = response.total ?? 0;
      processedCollections = response.completed ?? 0;
      
      // Use photo-level percentage if available (more accurate)
      if (response.percent !== undefined && response.totalPhotos !== undefined && response.totalPhotos > 0) {
        if (loaderPercent) {
          loaderPercent.textContent = `${response.percent}%`;
        }
      } else {
        // Fallback to collection-level percentage
        if (loaderPercent) {
          loaderPercent.textContent = totalCollections
            ? `${Math.round((processedCollections / totalCollections) * 100)}%`
            : "0%";
        }
      }
      const paused = response.profile.paused ?? false;
      showView("progress");
      setActionMode(true);
      showLoader();
      applyLoaderPauseState(paused);
      updatePauseResumeControls(paused);
      migrationActive = !paused;
      // Show appropriate status and progress text
      if (paused) {
        updateStatus("Migration paused");
        updateProgress("Migration paused - click Resume to continue");
      } else {
        updateStatus("Migration in progress...");
        // Only show "Migration in progress..." if we have actual progress
        if (response.percent !== undefined && response.percent > 0) {
          updateProgress(`Migration in progress... ${response.percent}%`);
        } else if (processedCollections > 0) {
          updateProgress(`Migration in progress... ${processedCollections}/${totalCollections} collections`);
        } else {
          updateProgress("Migration in progress...");
        }
      }
    } else {
      hideLoader();
      setActionMode(false);
      showView("start");
      if ((response.total ?? 0) === 0) {
        chrome.runtime.sendMessage({ type: "fetchCollections", page: 1 }, (resp) => {
          if (resp?.loggedIn) {
            updateCount(resp.total);
          }
        });
      }
      if (response.profile.migrationStatus === "completed") {
        // Keep migration buttons enabled even after completion for re-migration
        toggleMigrationActions(true);
        updateStatus("Migration completed");
        const summary = response.profile.summary;
        updateSummary(summary);
        currentSummary = summary;
      } else {
        toggleMigrationActions(true);
        updateStatus("Ready to migrate");
        migrationSummary?.classList.add("hidden");
      }
    }
  } catch (error) {
    showView("login");
    toggleLoginButton(true);
  }
};

const showView = (view: "login" | "start" | "progress") => {
  [loginView, startView, progressView].forEach((viewEl) => viewEl?.classList.add("hidden"));
  if (view === "login") {
    loginView?.classList.remove("hidden");
    toggleLoginButton(true);
  } else if (view === "start") {
    startView?.classList.remove("hidden");
    toggleLoginButton(false);
  } else {
    progressView?.classList.remove("hidden");
    toggleLoginButton(false);
  }
};

const setActionMode = (migrating: boolean) => {
  migrationActive = migrating;
  mainActions?.classList.toggle("hidden", migrating);
  activeActions?.classList.toggle("hidden", !migrating);
};

const showLoader = () => {
  loader?.classList.remove("hidden");
  loader?.classList.remove("paused");
};

const hideLoader = () => loader?.classList.add("hidden");

const applyLoaderPauseState = (paused: boolean) => {
  if (!loader) {
    return;
  }

  if (paused) {
    loader.classList.add("paused");
  } else {
    loader.classList.remove("paused");
  }
};

const updatePauseResumeControls = (paused: boolean) => {
  if (paused) {
    pauseButton?.classList.add("hidden");
    resumeButton?.classList.remove("hidden");
    resumeButton?.removeAttribute("disabled");
  } else {
    pauseButton?.classList.remove("hidden");
    resumeButton?.classList.add("hidden");
  }
};

const enterMigrationView = (initialCompleted = 0) => {
  setActionMode(true);
  showView("progress");
  showLoader();
  migrationActive = true;
  processedCollections = initialCompleted;
  updateProgress("Preparing migration...");
  pauseButton?.removeAttribute("disabled");
  resumeButton?.classList.add("hidden");
};

const exitMigrationView = () => {
  setActionMode(false);
  showView("start");
  hideLoader();
  migrationActive = false;
  processedCollections = 0;
  totalCollections = 0;
  updateProgress("");
  pauseButton?.removeAttribute("disabled");
  resumeButton?.classList.add("hidden");
};

const updateModalStatus = (text: string) => {
  if (modalStatus) {
    modalStatus.textContent = text;
  }
};

const renderCollections = (collections: CollectionSummary[]) => {
  if (!modalList) {
    return;
  }

  modalList.innerHTML = "";
  if (!collections.length) {
    modalList.innerHTML = '<p class="muted">No collections found for this page.</p>';
    return;
  }

  collections.forEach((collection) => {
    const item = document.createElement("label");
    item.className = "collection-item";
    const thumbnailRaw = collection.coverPhotoThumbnail ?? collection.coverPhoto ?? "";
    const thumbnail = thumbnailRaw.startsWith("//") ? `https:${thumbnailRaw}` : thumbnailRaw;
    const displayName = truncateCollectionName(collection.name);
    item.innerHTML = `
      <input type="checkbox" class="collection-check" data-id="${collection.id}">
      <img class="collection-cover" src="${thumbnail}" alt="${displayName}" />
      <div class="collection-meta">
        <p class="collection-title" title="${collection.name}">${displayName}</p>
        <p class="collection-subtitle">${collection.photo_count ?? 0} photos</p>
      </div>
    `;

    const checkbox = item.querySelector(".collection-check") as HTMLInputElement | null;
    checkbox?.addEventListener("change", (event) => {
      const id = Number((event.target as HTMLInputElement).dataset.id);
      if ((event.target as HTMLInputElement).checked) {
        selectedIds.add(id);
      } else {
        selectedIds.delete(id);
      }
      updateModalConfirm();
    });

    if (selectedIds.has(collection.id) && checkbox) {
      checkbox.checked = true;
    }

    modalList.appendChild(item);
  });
};

const updateModalConfirm = () => {
  if (!modalConfirm) {
    return;
  }

  if (selectedIds.size > 0) {
    modalConfirm.removeAttribute("disabled");
  } else {
    modalConfirm.setAttribute("disabled", "true");
  }
};

const updateModalPagination = () => {
  if (modalPrev) {
    modalPrev.disabled = (modalMeta.current_page ?? 1) <= 1;
  }
  if (modalNext) {
    modalNext.disabled = (modalMeta.last_page ?? 1) <= (modalMeta.current_page ?? 1);
  }

  if (modalPageInfo) {
    modalPageInfo.textContent = `${modalMeta.current_page ?? modalCurrentPage} / ${modalMeta.last_page ?? modalMeta.current_page ?? 1}`;
  }
};

const bootstrap = async () => {
  updateStatus("Checking Pixieset login…");
  toggleLoginButton(false);
  toggleMigrationActions(false);

  try {
    const response = (await chrome.runtime.sendMessage({ type: "bootstrap" })) as BootstrapResponse;
    if (response.loggedIn) {
      isLoggedIn = true;
      updateUserInfo(response);
      updateStatus("Ready to migrate");
      toggleMigrationActions(true);
      refreshProfileStatus();
    } else if (response.status === 401) {
      isLoggedIn = false;
      updateStatus("Pixieset login required");
      toggleLoginButton(true);
    } else {
      isLoggedIn = false;
      updateStatus("Unable to verify Pixieset session");
      toggleLoginButton(true);
    }
  } catch (error) {
    isLoggedIn = false;
    updateStatus("Session bootstrap failed");
    toggleLoginButton(true);
  }
};

const openModal = async () => {
  if (!isLoggedIn || !selectionModal) {
    return;
  }

  selectedIds.clear();
  updateModalConfirm();
  selectionModal.classList.remove("hidden");
  updateModalStatus("Loading all collections...");
  
  try {
    const response = (await chrome.runtime.sendMessage({ type: "getAllCollections" })) as {
      loggedIn: boolean;
      collections?: CollectionSummary[];
      total?: number;
    };
    
    if (response.loggedIn && response.collections) {
      modalCollections = response.collections;
      const total = response.total ?? response.collections.length;
      if (rangeStartInput) {
        rangeStartInput.min = "1";
        rangeStartInput.max = String(total);
        rangeStartInput.placeholder = "1";
      }
      if (rangeEndInput) {
        rangeEndInput.min = "1";
        rangeEndInput.max = String(total);
        rangeEndInput.placeholder = String(total);
      }
      if (rangeHint) {
        rangeHint.textContent = `Index 1 to ${total} (inclusive)`;
      }
      renderCollections(response.collections);
      updateModalStatus(`All ${total} collections loaded`);
      // Hide pagination controls since we're showing all
      modalPrev?.classList.add("hidden");
      modalNext?.classList.add("hidden");
      modalPageInfo?.classList.add("hidden");
    } else {
      modalCollections = [];
      updateModalStatus("Failed to load collections");
    }
  } catch (error) {
    updateModalStatus("Failed to load collections");
  }
};

const closeModal = () => {
  selectionModal?.classList.add("hidden");
  selectedIds.clear();
  updateModalConfirm();
};

const fetchModalPage = async (page = 1) => {
  if (!isLoggedIn) {
    updateModalStatus("Login required to view collections");
    return;
  }

  modalCurrentPage = page;
  updateModalStatus("Loading collections…");
  try {
    const response = (await chrome.runtime.sendMessage({ type: "fetchCollections", page })) as DashboardResponse;
    if (response.loggedIn) {
      modalMeta = response.meta;
      renderCollections(response.collections);
      updateModalPagination();
      updateModalStatus(`Page ${modalMeta.current_page ?? page}`);
      updateCount(response.count);
    } else if (response.status === 401) {
      updateModalStatus("Login required to view collections");
      toggleLoginButton(true);
    } else {
      updateModalStatus("Unable to load collections");
    }
  } catch (error) {
    updateModalStatus("Failed to load collections");
  }
};

const startMigration = async ({
  all = false,
  selected = [],
  concurrency: concurrencyOverride
}: { all?: boolean; selected?: number[]; concurrency?: number } = {}) => {
  const concurrencyFromUI = concurrencyFactorInput ? parseInt(concurrencyFactorInput.value, 10) || 3 : 3;
  const concurrency = Math.max(1, Math.min(20, concurrencyOverride ?? lastMigrationOptions.concurrency ?? concurrencyFromUI));
  lastMigrationOptions = { all, selected, concurrency };
  closeModal(); // Close modal immediately when migration starts
  enterMigrationView();

  const payload = all
    ? { type: "startMigration", all: true, concurrency }
    : { type: "startMigration", selected, concurrency };
  try {
    const response = (await chrome.runtime.sendMessage(payload)) as Record<string, unknown>;
    if (response?.success) {
      updateStatus(all ? "Migrating all collections" : `Migrating ${selected.length} selected collection(s)`);
    } else {
      updateStatus("Unable to start migration");
    }
  } catch (error) {
    updateStatus("Failed to start migration");
  }
};

migrateAllButton?.addEventListener("click", () => {
  if (!isLoggedIn) {
    updateStatus("Login required to migrate");
    toggleLoginButton(true);
    return;
  }

  startMigration({ all: true });
});

selectButton?.addEventListener("click", () => {
  openModal();
});

const redirectToLogin = () => chrome.tabs.create({ url: "https://galleries.pixieset.com/collections" });
loginButton?.addEventListener("click", () => redirectToLogin());
heroLoginBtn?.addEventListener("click", () => redirectToLogin());

modalClose?.addEventListener("click", () => {
  closeModal();
});

selectRangeBtn?.addEventListener("click", () => {
  if (!modalCollections.length || !rangeStartInput || !rangeEndInput) return;
  const total = modalCollections.length;
  let start = parseInt(rangeStartInput.value, 10) || 1;
  let end = parseInt(rangeEndInput.value, 10) || total;
  start = Math.max(1, Math.min(start, total));
  end = Math.max(1, Math.min(end, total));
  if (start > end) {
    [start, end] = [end, start];
  }
  for (let i = start; i <= end; i++) {
    selectedIds.add(modalCollections[i - 1].id);
  }
  renderCollections(modalCollections);
  updateModalConfirm();
});

// Summary detail modal event listeners
summaryExpand?.addEventListener("click", () => {
  if (summaryDetailModal?.classList.contains("hidden")) {
    openSummaryDetail();
  } else {
    closeSummaryDetail();
  }
});

summaryModalClose?.addEventListener("click", () => {
  closeSummaryDetail();
});

summaryDownload?.addEventListener("click", () => {
  downloadSummary();
});

// Close modal when clicking outside
summaryDetailModal?.addEventListener("click", (e) => {
  if (e.target === summaryDetailModal) {
    closeSummaryDetail();
  }
});

modalPrev?.addEventListener("click", () => {
  const prevPage = (modalMeta.current_page ?? modalCurrentPage) - 1;
  if (prevPage >= 1) {
    fetchModalPage(prevPage);
  }
});

modalNext?.addEventListener("click", () => {
  const nextPage = (modalMeta.current_page ?? modalCurrentPage) + 1;
  if (nextPage <= (modalMeta.last_page ?? modalCurrentPage)) {
    fetchModalPage(nextPage);
  }
});

modalConfirm?.addEventListener("click", () => {
  if (selectedIds.size === 0) {
    return;
  }
  startMigration({ selected: Array.from(selectedIds) });
});

pauseButton?.addEventListener("click", () => {
  if (!migrationActive) {
    return;
  }
  chrome.runtime.sendMessage({ type: "pauseMigration" });
});

resumeButton?.addEventListener("click", () => {
  if (migrationActive) {
    return;
  }
  startMigration(lastMigrationOptions);
});

document.addEventListener("DOMContentLoaded", () => {
  bootstrap();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "migrationProgress") {
    const rawName = message.collectionName ?? message.name ?? `Collection ${message.collectionId}`;
    const collectionName = truncateCollectionName(rawName);
    
    // Use percentage from message if available (photo-level progress)
    if (message.percent !== undefined) {
      loaderPercent && (loaderPercent.textContent = `${message.percent}%`);
      
      // Update collection name display
      if (message.status === "in_progress") {
        loaderCollection && (loaderCollection.textContent = `Migrating ${collectionName}`);
        loaderCollection?.classList.remove("slide-out");
        loaderCollection?.classList.add("slide-in");
      }
      
      // Update progress text with photo details if available
      if (message.currentPhotoIndex !== undefined && message.totalPhotos !== undefined) {
        updateProgress(`Photo ${message.currentPhotoIndex} of ${message.totalPhotos} in ${collectionName}`);
      } else {
        updateProgress(`Migrating ${collectionName}`);
      }
    } else {
      // Fallback to collection-level progress (legacy)
      const galleryCount = message.galleryCount ?? "unknown";
      updateProgress(`${collectionName} ${message.status} (${galleryCount} galleries)`);
      
      if (message.status === "in_progress") {
        loaderCollection && (loaderCollection.textContent = `Migrating ${collectionName}`);
        loaderCollection?.classList.remove("slide-out");
        loaderCollection?.classList.add("slide-in");
      }
      
      if (message.status === "completed") {
        processedCollections += 1;
        const percent = totalCollections ? Math.min(100, Math.round((processedCollections / totalCollections) * 100)) : 100;
        loaderPercent && (loaderPercent.textContent = `${percent}%`);
        loaderCollection?.classList.remove("slide-in");
        loaderCollection?.classList.add("slide-out");
      }
    }
    return true;
  }

  if (message.type === "migrationPaused") {
    updateStatus("Migration paused due to authentication");
    updateProgress("");
    toggleLoginButton(true);
    setActionMode(true);
    showView("progress");
    showLoader();
    applyLoaderPauseState(true);
    updatePauseResumeControls(true);
    migrationActive = false;
    return true;
  }

  if (message.type === "migrationStarted") {
    totalCollections = message.total ?? totalCollections;
    processedCollections = message.completed ?? 0;
    
    // Use photo-level percentage if available
    if (message.percent !== undefined && message.totalPhotos !== undefined) {
      loaderPercent && (loaderPercent.textContent = `${message.percent}%`);
    } else {
      // Fallback to collection-level percentage
      const percent = totalCollections ? Math.round((processedCollections / totalCollections) * 100) : 0;
      loaderPercent && (loaderPercent.textContent = `${percent}%`);
    }
    
    // Show appropriate message based on whether we're resuming or starting fresh
    if (message.isResuming) {
      updateProgress("Resuming migration...");
    } else {
      updateProgress("Starting migration...");
    }
    
    showLoader();
    applyLoaderPauseState(false);
    updatePauseResumeControls(false);
    migrationActive = true;
    return true;
  }

  if (message.type === "migrationCompleted") {
    updateProgress("Migration complete");
    // Refresh profile status to get the updated "completed" status from IndexedDB
    refreshProfileStatus();
    return true;
  }

  return false;
});


