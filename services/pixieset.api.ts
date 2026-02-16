import { Logger } from "../background/logger.js";
import { retryWithBackoff, shouldRetryHttpError } from "../utils/retry.js";

const DASHBOARD_API = "https://galleries.pixieset.com/api/v1/dashboard_listings";
const BOOTSTRAP_API = "https://galleries.pixieset.com/api/v1/data/bootstrap";

const logger = new Logger();
const API_TAG = "[pixieset-api]";

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

type DashboardSuccess = {
  loggedIn: true;
  count: number;
  status: number;
  collections: CollectionSummary[];
  meta: PaginationMeta;
};

type DashboardFailure = {
  loggedIn: false;
  status: number;
  error?: string;
};

export type DashboardResponse = DashboardSuccess | DashboardFailure;

type BootstrapSuccess = {
  loggedIn: true;
  username: string;
  email: string;
  businessName?: string;
  status: number;
};

type BootstrapFailure = {
  loggedIn: false;
  status: number;
  error?: string;
};

export type BootstrapResponse = BootstrapSuccess | BootstrapFailure;

const commonHeaders = {
  Accept: "application/json, text/plain, */*",
  "X-Requested-With": "XMLHttpRequest",
  Pragma: "no-cache",
  "Cache-Control": "no-cache"
};

/**
 * Determines if a Pixieset API error should be retried
 * Does not retry 401/403 (authentication errors)
 */
function shouldRetryPixiesetError(error: unknown): boolean {
  // Don't retry authentication errors
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status;
    if (status === 401 || status === 403) {
      return false;
    }
  }
  // Use default HTTP retry logic for other errors
  return shouldRetryHttpError(error);
}

export async function fetchBootstrap(): Promise<BootstrapResponse> {
  const endpoint = "/api/v1/data/bootstrap";
  const url = BOOTSTRAP_API;
  
  try {
    const response = await retryWithBackoff(
      async () => {
        const res = await fetch(url, {
          credentials: "include",
          headers: commonHeaders
        });

        if (res.status === 401) {
          // Don't retry authentication errors - return response as-is
          return res;
        }

        if (!res.ok) {
          throw { status: res.status, statusText: res.statusText };
        }

        return res;
      },
      3, // maxRetries
      1000, // initialDelayMs
      shouldRetryPixiesetError
    );

    // Handle authentication error response
    if (response.status === 401) {
      logger.warn(`${API_TAG} API call unauthorized: ${endpoint}`, {
        endpoint,
        url,
        status: 401
      });
      return { loggedIn: false, status: 401 };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const data = payload?.data as Record<string, unknown> | undefined;
    const user = data?.user as Record<string, unknown> | undefined;
    const profile = data?.profile as Record<string, unknown> | undefined;

    return {
      loggedIn: true,
      status: response.status,
      username: (user?.username as string) ?? "user",
      email: (user?.email as string) ?? "",
      businessName: profile?.business_name as string | undefined
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    logger.error(`${API_TAG} API call exception: ${endpoint} - ${errorMessage}`, {
      endpoint,
      url,
      error: error instanceof Error ? error.stack : String(error)
    });
    return { loggedIn: false, status: 0, error: errorMessage };
  }
}

export async function fetchDashboard(page = 1): Promise<DashboardResponse> {
  const endpoint = "/api/v1/dashboard_listings";
  const url = `${DASHBOARD_API}?page=${page}`;
  
  try {
    const response = await retryWithBackoff(
      async () => {
        const res = await fetch(url, {
          credentials: "include",
          headers: commonHeaders
        });
        if (res.status === 401) return res;
        if (!res.ok) throw { status: res.status, statusText: res.statusText };
        return res;
      },
      3,
      1000,
      shouldRetryPixiesetError
    );

    if (response.status === 401) {
      logger.warn(`${API_TAG} API call unauthorized: ${endpoint}`, { endpoint, url, status: 401, page });
      return { loggedIn: false, status: 401 };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const data = payload?.data as Record<string, unknown> | undefined;
    const inner = data?.data as Record<string, unknown> | undefined;
    const collections = (inner?.collections as CollectionSummary[] | undefined) ?? [];
    const meta = (data?.meta as PaginationMeta | undefined) ?? {};
    const count = meta.total ?? collections.length;

    return {
      loggedIn: true,
      count,
      status: response.status,
      collections,
      meta
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    logger.error(`${API_TAG} API call exception: ${endpoint} - ${errorMessage}`, {
      endpoint,
      url,
      page,
      error: error instanceof Error ? error.stack : String(error)
    });
    return { loggedIn: false, status: 0, error: errorMessage };
  }
}

export type CollectionDetail = {
  data: {
    collection: { id: number; name: string; photo_count?: number };
    galleries: { id: number; name: string; photo_count: number }[];
  };
};

export async function fetchCollectionDetail(collectionId: number): Promise<CollectionDetail> {
  const endpoint = `/api/v1/collections/${collectionId}/before_show`;
  const url = `https://galleries.pixieset.com${endpoint}`;
  const headers = {
    ...commonHeaders,
    "Referer": `https://galleries.pixieset.com/collections/${collectionId}/sets`,
    "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
    "User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "Sec-CH-UA": `"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"`,
    "Sec-CH-UA-Mobile": "?1",
    "Sec-CH-UA-Platform": `"Android"`
  };
  
  try {
    const response = await retryWithBackoff(
      async () => {
        const res = await fetch(url, { credentials: "include", headers });
        if (res.status === 401 || res.status === 403) {
          throw Object.assign(new Error("unauthorized"), { status: res.status, noRetry: true });
        }
        if (!res.ok) throw { status: res.status, statusText: res.statusText };
        return res;
      },
      3,
      1000,
      (error) => {
        if (error && typeof error === 'object' && 'noRetry' in error) return false;
        return shouldRetryPixiesetError(error);
      }
    );

    return (await response.json()) as CollectionDetail;
  } catch (error) {
    // Re-throw "unauthorized" errors as-is
    if (error instanceof Error && error.message === "unauthorized") {
      throw error;
    }
    
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    logger.error(`${API_TAG} API call exception: ${endpoint} - ${errorMessage}`, {
      endpoint,
      url,
      collectionId,
      error: error instanceof Error ? error.stack : String(error)
    });
    throw error;
  }
}

export type GalleryDetail = {
  data: {
    id: number;
    collection_id: number;
    name: string;
    description: string | null;
    photo_count: number;
    download: boolean;
    private: boolean;
    photos: Array<{
      id: number;
      path_xxlarge: string;
      [key: string]: unknown;
    }>;
    videos?: Array<{
      id: number;
      name: string;
      video_source: string;
      width?: number;
      height?: number;
      provider_id?: number;
      mux_status?: number;
      metadata?: string;
      thumbnail_path?: string;
      poster_path?: string;
    }>;
  };
};

export async function fetchGalleryDetail(galleryId: number, collectionId: number): Promise<GalleryDetail> {
  const endpoint = `/api/v1/galleries/${galleryId}`;
  const url = `https://galleries.pixieset.com${endpoint}?expand=photos.starred%2Cvideos`;
  const headers = {
    ...commonHeaders,
    "Referer": `https://galleries.pixieset.com/collections/${collectionId}/sets/${galleryId}`,
    "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
    "User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "Sec-CH-UA": `"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"`,
    "Sec-CH-UA-Mobile": "?1",
    "Sec-CH-UA-Platform": `"Android"`
  };
  
  try {
    const response = await retryWithBackoff(
      async () => {
        const res = await fetch(url, { credentials: "include", headers });
        if (res.status === 401 || res.status === 403) {
          throw Object.assign(new Error("unauthorized"), { status: res.status, noRetry: true });
        }
        if (!res.ok) throw { status: res.status, statusText: res.statusText };
        return res;
      },
      3,
      1000,
      (error) => {
        if (error && typeof error === 'object' && 'noRetry' in error) return false;
        return shouldRetryPixiesetError(error);
      }
    );

    return (await response.json()) as GalleryDetail;
  } catch (error) {
    // Re-throw "unauthorized" errors as-is
    if (error instanceof Error && error.message === "unauthorized") {
      throw error;
    }
    
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    logger.error(`${API_TAG} API call exception: ${endpoint} - ${errorMessage}`, {
      endpoint,
      url,
      galleryId,
      collectionId,
      error: error instanceof Error ? error.stack : String(error)
    });
    throw error;
  }
}
