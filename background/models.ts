/** Photo object from Pixieset gallery API (subset used for upload + metadata) */
export interface PixiesetPhoto {
  id: number;
  path_xxlarge: string;
  name?: string;
  mime_type?: string;
  ext?: string;
  size?: number;
  width?: number;
  height?: number;
  user_id?: number;
  gallery_id?: number;
  collection_id?: number;
  rank?: number;
  status?: number;
  capture_date?: string;
  watermark?: number;
  mark_private_at?: string;
  visibility_status?: number;
  starred?: boolean;
}

export type MigrationStatus = "not_selected" | "pending" | "in_progress" | "completed" | "failed";
export type ProfileMigrationStatus = "not_started" | "in_progress" | "completed";

export interface FailedImage {
  id: string;
  name: string;
  reason?: string; // Failure reason/error message
}

export interface CollectionFailureInfo {
  collectionId: number;
  collectionName: string;
  failedImageCount: number;
  failedImages: FailedImage[]; // Only populated if failedImageCount < 3
}

export interface MigrationSummary {
  totalCollections: number;
  totalGalleries: number;
  totalImages: number;
  failedCollections: number[]; // Collection IDs that failed completely
  failedImagesByCollection: CollectionFailureInfo[]; // Per-collection failure details
  startTime?: number; // Timestamp when migration started (milliseconds since epoch)
  pausedDuration?: number; // Total time spent paused in milliseconds
  lastPauseStartTime?: number; // Timestamp when migration was last paused (for calculating pause duration)
  endTime?: number; // Timestamp when migration completed (milliseconds since epoch)
  elapsedTime?: number; // Elapsed time for the current/last run excluding paused periods (ms)
  totalElapsedTime?: number; // Cumulative elapsed time from all previous completed runs (ms)
}

export interface PauseState {
  collectionId?: number;
  galleryId?: number;
  photoIndex?: number; // Index within the current gallery
}

export interface ProfileRecord {
  key: string; // email
  username: string;
  email: string;
  businessName?: string;
  migrationStatus: ProfileMigrationStatus;
  paused: boolean;
  summary?: MigrationSummary;
  pauseState?: PauseState; // Track where migration was paused
  /** Concurrency used for migration; restored on resume when popup doesn't send it */
  lastConcurrency?: number;
  /** Set when bootstrap dump (user_metadata.json) has been uploaded for this user so we don't re-upload */
  userMetadataUploaded?: boolean;
  /** Collection IDs for the active migration run (for accurate x/y progress; cleared when migration finishes) */
  migrationSelectedIds?: number[];
}

export interface CollectionRecord {
  id: number;
  name: string;
  status: MigrationStatus;
  reason?: string;
}
