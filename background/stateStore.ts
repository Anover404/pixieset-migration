import { CollectionRecord, ProfileRecord, MigrationStatus, ProfileMigrationStatus, MigrationSummary, PauseState } from "./models.js";

const DB_NAME = "pixiesetMigrator";
const PROFILE_STORE = "profile";
const COLLECTION_STORE = "collections";

export class StateStore {
  private dbPromise: Promise<IDBDatabase>;
  private pausedCache: { value: boolean; at: number } | null = null;
  private static readonly PAUSED_CACHE_MS = 50;

  constructor() {
    this.dbPromise = this.open();
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PROFILE_STORE)) {
          db.createObjectStore(PROFILE_STORE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(COLLECTION_STORE)) {
          db.createObjectStore(COLLECTION_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private requestPromise<T>(request: IDBRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  }

  async saveProfile(input: Omit<ProfileRecord, "key">) {
    const db = await this.dbPromise;
    const tx = db.transaction(PROFILE_STORE, "readwrite");
    const store = tx.objectStore(PROFILE_STORE);
    const toSave: ProfileRecord = {
      key: input.email,
      ...input,
      migrationStatus: input.migrationStatus ?? "not_started",
      paused: input.paused ?? false
    };
    store.put(toSave);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadProfile(email: string): Promise<ProfileRecord | undefined> {
    const db = await this.dbPromise;
    const tx = db.transaction(PROFILE_STORE, "readonly");
    const store = tx.objectStore(PROFILE_STORE);
    const request = store.get(email);
    const result = await this.requestPromise<ProfileRecord | undefined>(request);
    return result;
  }

  async loadAnyProfile(): Promise<ProfileRecord | undefined> {
    const db = await this.dbPromise;
    const tx = db.transaction(PROFILE_STORE, "readonly");
    const store = tx.objectStore(PROFILE_STORE);
    const request = store.openCursor();
    const cursor = await this.requestPromise<IDBCursorWithValue | null>(request);
    return cursor?.value;
  }

  async getCollections(): Promise<CollectionRecord[]> {
    const db = await this.dbPromise;
    const tx = db.transaction(COLLECTION_STORE, "readonly");
    const store = tx.objectStore(COLLECTION_STORE);
    const request = store.getAll();
    return await this.requestPromise<CollectionRecord[]>(request);
  }

  async syncCollections(items: { id: number; name: string }[]) {
    const existing = await this.getCollections();
    const existingMap = new Map(existing.map((record) => [record.id, record]));
    const db = await this.dbPromise;
    const tx = db.transaction(COLLECTION_STORE, "readwrite");
    const store = tx.objectStore(COLLECTION_STORE);

    items.forEach(({ id, name }) => {
      const current = existingMap.get(id);
      store.put({
        id,
        name,
        status: current?.status ?? "not_selected",
        reason: current?.reason
      });
    });

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async setPending(ids: number[], selective = false) {
    const collections = await this.getCollections();
    const db = await this.dbPromise;
    const tx = db.transaction(COLLECTION_STORE, "readwrite");
    const store = tx.objectStore(COLLECTION_STORE);

    collections.forEach((record) => {
      // Preserve "completed" status - don't reset completed collections
      if (record.status === "completed") {
        return;
      }
      const shouldPending = selective ? ids.includes(record.id) : true;
      store.put({
        ...record,
        status: shouldPending ? "pending" : "not_selected",
        reason: undefined
      });
    });

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async setPaused(paused: boolean, pauseState?: PauseState) {
    const db = await this.dbPromise;
    const tx = db.transaction(PROFILE_STORE, "readwrite");
    const store = tx.objectStore(PROFILE_STORE);
    const cursorRequest = store.openCursor();
    const cursor = await this.requestPromise<IDBCursorWithValue | null>(cursorRequest);
    const profile = cursor?.value;
    if (!profile) {
      return;
    }
    
    const now = Date.now();
    let updatedSummary = profile.summary ? { ...profile.summary } : undefined;
    
    // Track pause/resume times
    if (updatedSummary && updatedSummary.startTime) {
      if (paused) {
        // Migration is being paused - record the pause start time
        if (!updatedSummary.pausedDuration) {
          updatedSummary.pausedDuration = 0;
        }
        updatedSummary.lastPauseStartTime = now;
      } else {
        // Migration is being resumed - calculate paused duration
        if (updatedSummary.lastPauseStartTime) {
          const pauseDuration = now - updatedSummary.lastPauseStartTime;
          updatedSummary.pausedDuration = (updatedSummary.pausedDuration || 0) + pauseDuration;
          updatedSummary.lastPauseStartTime = undefined;
        }
      }
    }
    
    store.put({ 
      ...profile, 
      paused,
      pauseState: paused && pauseState ? pauseState : (paused ? profile.pauseState : undefined),
      summary: updatedSummary
    });
    this.pausedCache = { value: paused, at: Date.now() };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getPauseState(): Promise<PauseState | undefined> {
    const profile = await this.loadAnyProfile();
    return profile?.pauseState;
  }

  async clearPauseState() {
    const profile = await this.loadAnyProfile();
    if (!profile) {
      return;
    }
    const db = await this.dbPromise;
    const tx = db.transaction(PROFILE_STORE, "readwrite");
    const store = tx.objectStore(PROFILE_STORE);
    store.put({ ...profile, pauseState: undefined });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async isPaused(): Promise<boolean> {
    const now = Date.now();
    if (this.pausedCache && now - this.pausedCache.at < StateStore.PAUSED_CACHE_MS) {
      return this.pausedCache.value;
    }
    const profile = await this.loadAnyProfile();
    const value = profile?.paused ?? false;
    this.pausedCache = { value, at: now };
    return value;
  }

  async getPendingCollections(): Promise<CollectionRecord[]> {
    const collections = await this.getCollections();
    return collections.filter((record) => record.status === "pending");
  }

  async updateStatus(id: number, status: MigrationStatus, reason?: string) {
    const collections = await this.getCollections();
    const record = collections.find((item) => item.id === id);
    if (!record) {
      return;
    }
    const db = await this.dbPromise;
    const tx = db.transaction(COLLECTION_STORE, "readwrite");
    const store = tx.objectStore(COLLECTION_STORE);
    store.put({
      ...record,
      status,
      reason
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async updateProfileStatus(status: ProfileMigrationStatus) {
    const profile = await this.loadAnyProfile();
    if (!profile) {
      return;
    }
    const db = await this.dbPromise;
    const tx = db.transaction(PROFILE_STORE, "readwrite");
    const store = tx.objectStore(PROFILE_STORE);
    store.put({ ...profile, migrationStatus: status });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Persist concurrency so resume uses the same value when popup doesn't send it */
  async updateProfileConcurrency(concurrency: number) {
    const profile = await this.loadAnyProfile();
    if (!profile) {
      return;
    }
    const db = await this.dbPromise;
    const tx = db.transaction(PROFILE_STORE, "readwrite");
    const store = tx.objectStore(PROFILE_STORE);
    store.put({ ...profile, lastConcurrency: concurrency });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async updateSummary(summary: MigrationSummary) {
    const profile = await this.loadAnyProfile();
    if (!profile) {
      return;
    }
    const db = await this.dbPromise;
    const tx = db.transaction(PROFILE_STORE, "readwrite");
    const store = tx.objectStore(PROFILE_STORE);
    store.put({ ...profile, summary });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Resets all collection statuses to "not_selected" for a fresh migration
   */
  async resetCollectionsStatus() {
    const collections = await this.getCollections();
    const db = await this.dbPromise;
    const tx = db.transaction(COLLECTION_STORE, "readwrite");
    const store = tx.objectStore(COLLECTION_STORE);

    collections.forEach((record) => {
      store.put({
        ...record,
        status: "not_selected",
        reason: undefined
      });
    });

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Resets profile migration status and summary for a fresh migration
   */
  async resetProfileMigration() {
    const profile = await this.loadAnyProfile();
    if (!profile) {
      return;
    }
    const db = await this.dbPromise;
    const tx = db.transaction(PROFILE_STORE, "readwrite");
    const store = tx.objectStore(PROFILE_STORE);
    store.put({
      ...profile,
      migrationStatus: "not_started",
      paused: false,
      summary: { totalCollections: 0, totalGalleries: 0, totalImages: 0, failedCollections: [], failedImagesByCollection: [] }
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
