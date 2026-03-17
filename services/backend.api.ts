import { Logger } from "../background/logger.js";
import { retryWithBackoff, shouldRetryHttpError } from "../utils/retry.js";

const BACKEND_BASE_URL = "https://pixie-set-backend-pxbb63zhgq-uc.a.run.app";

const AUTH_TOKEN = "test-migration-token";

const logger = new Logger();
const API_TAG = "[backend-api]";

export type CreateAlbumRequest = {
  albumName: string;
  fullMetadata: Record<string, unknown>;
  domain: string;
  albumId?: string;
  userEmail?: string;
};

export type CreateAlbumResponse = {
  success: boolean;
  albumId?: string;
  message?: string;
  error?: string;
};

export type GetUploadUrlRequest = {
  filename: string | string[];
  albumName: string;
  domain: string;
  albumId?: string;
  /** Array of metadata objects, one per filename; each object is x-goog-meta-* header name -> value for signing */
  metadata?: Array<Record<string, string>>;
};

export type GetUploadUrlResponse = {
  ok: boolean;
  skipped?: boolean;
  uploadUrl?: string;
  objectPath?: string;
  error?: string;
};

export type GetUploadUrlBatchResponse = GetUploadUrlResponse[];

/**
 * Gets a presigned URL for uploading user_metadata.json (bootstrap dump) under domain.
 * Used once per user at migration start.
 */
export async function getUserMetadataUploadUrl(domain: string): Promise<GetUploadUrlResponse> {
  const endpoint = "/api/get-user-metadata-upload-url";
  const url = `${BACKEND_BASE_URL}${endpoint}`;
  try {
    const response = await retryWithBackoff(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            authorization: AUTH_TOKEN
          },
          body: JSON.stringify({ domain })
        });
        if (!res.ok) {
          const errorData = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          const errorMessage = (errorData.error as string) ?? `HTTP ${res.status}: ${res.statusText}`;
          throw { status: res.status, statusText: res.statusText, errorMessage, errorData };
        }
        return res;
      },
      3,
      1000,
      shouldRetryHttpError
    );
    return (await response.json()) as GetUploadUrlResponse;
  } catch (error) {
    const errorMessage =
      error && typeof error === "object" && "errorMessage" in error
        ? (error as { errorMessage: string }).errorMessage
        : (error instanceof Error ? error.message : "Unknown error");
    logger.error(`${API_TAG} API call exception: ${endpoint} - ${errorMessage}`, {
      endpoint,
      url,
      error: error instanceof Error ? error.stack : String(error)
    });
    return { ok: false, error: errorMessage };
  }
}

/**
 * Creates a Pixieset album in the backend
 * @param albumName - The collection name
 * @param fullMetadata - The complete JSON response from fetchCollectionDetail
 * @param domain - The username from the bootstrap/profile
 * @param albumId - Optional collection ID
 * @param userEmail - Optional user email from the profile
 * @returns Response from the backend API
 */
export async function createPixiesetAlbum(
  albumName: string,
  fullMetadata: Record<string, unknown>,
  domain: string,
  albumId?: string,
  userEmail?: string
): Promise<CreateAlbumResponse> {
  const endpoint = "/api/create-pixieset-album";
  const url = `${BACKEND_BASE_URL}${endpoint}`;
  
  try {
    const response = await retryWithBackoff(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            authorization: AUTH_TOKEN
          },
          body: JSON.stringify({
            albumName,
            fullMetadata,
            domain,
            ...(albumId && { albumId }),
            ...(userEmail && { userEmail })
          })
        });

        if (!res.ok) {
          const errorData = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          const errorMessage = errorData.message as string ?? `HTTP ${res.status}: ${res.statusText}`;
          throw { status: res.status, statusText: res.statusText, errorMessage, errorData };
        }

        return res;
      },
      3, // maxRetries
      1000, // initialDelayMs
      shouldRetryHttpError
    );

    const data = (await response.json()) as CreateAlbumResponse;
    return {
      ...data,
      success: data.success ?? true
    };
  } catch (error) {
    const errorMessage = (error && typeof error === 'object' && 'errorMessage' in error)
      ? (error as { errorMessage: string }).errorMessage
      : (error instanceof Error ? error.message : "Unknown error occurred");
    
    logger.error(`${API_TAG} API call exception: ${endpoint} - ${errorMessage}`, {
      endpoint,
      url,
      error: error instanceof Error ? error.stack : String(error)
    });
    return {
      success: false,
      error: errorMessage
    };
  }
}

/**
 * Gets a presigned upload URL for uploading an image to GCP
 * @param filename - The filename of the image (or array of filenames for batch)
 * @param albumName - The album/collection name
 * @param domain - The username/domain
 * @param metadata - Optional array of metadata objects, one per filename (x-goog-meta-* headers for signing)
 * @returns Response with upload URL or skip status (or array of responses for batch)
 */
export async function getPixiesetUploadUrl(
  filename: string | string[],
  albumName: string,
  domain: string,
  albumId?: string,
  metadata?: Array<Record<string, string>>
): Promise<GetUploadUrlResponse | GetUploadUrlBatchResponse> {
  const endpoint = "/api/get-pixieset-upload-url";
  const url = `${BACKEND_BASE_URL}${endpoint}`;
  const isBatch = Array.isArray(filename);
  
  try {
    const response = await retryWithBackoff(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            authorization: AUTH_TOKEN
          },
          body: JSON.stringify({
            filename,
            albumName,
            domain,
            ...(albumId && { albumId }),
            ...(metadata != null && metadata.length > 0 && { metadata })
          })
        });

        if (!res.ok) {
          const errorData = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          const errorMessage = errorData.error as string ?? `HTTP ${res.status}: ${res.statusText}`;
          throw { status: res.status, statusText: res.statusText, errorMessage, errorData };
        }

        return res;
      },
      3, // maxRetries
      1000, // initialDelayMs
      shouldRetryHttpError
    );

    const data = await response.json();
    
    // If batch request, return array; otherwise return single response
    if (isBatch) {
      return data as GetUploadUrlBatchResponse;
    }
    
    return data as GetUploadUrlResponse;
  } catch (error) {
    const errorMessage = (error && typeof error === 'object' && 'errorMessage' in error)
      ? (error as { errorMessage: string }).errorMessage
      : (error instanceof Error ? error.message : "Unknown error occurred");
    
    logger.error(`${API_TAG} API call exception: ${endpoint} - ${errorMessage}`, {
      endpoint,
      url,
      error: error instanceof Error ? error.stack : String(error),
      filename: isBatch ? `${filename.length} files` : filename,
      albumName
    });
    
    if (isBatch) {
      // Return array of error responses for batch
      return filename.map(() => ({
        ok: false,
        error: errorMessage
      }));
    }
    
    return {
      ok: false,
      error: errorMessage
    };
  }
}
