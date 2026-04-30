/**
 * LangLearn — IndexedDB Database
 *
 * A vanilla IndexedDB wrapper to avoid external dependencies.
 * Stores recognized words matching the user's Anki collection inside the extension's local storage.
 */

const DB_NAME = 'langlearn_db';
const STORE_NAME = 'known_words';
const DB_VERSION = 1;

class Database {
  constructor() {
    this.db = null;
    this.initPromise = null;
  }

  async init() {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'word' });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve();
      };

      request.onerror = (event) => {
        console.error('[LangLearn] DB init error:', event.target.error);
        reject(event.target.error);
      };
    });

    return this.initPromise;
  }

  /**
   * Clears the existing known_words store and inserts all elements from `words`.
   * @param {string[]} words 
   * @returns {Promise<void>}
   */
  async putAll(words) {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      store.clear();

      for (const word of words) {
        if (!word) continue;
        store.put({ word });
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = (event) => reject(event.target.error);
    });
  }

  /**
   * Retrieves all known words.
   * @returns {Promise<Set<string>>}
   */
  async getAll() {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = (event) => {
        const records = event.target.result || [];
        resolve(new Set(records.map((r) => r.word)));
      };

      request.onerror = (event) => reject(event.target.error);
    });
  }
}

export const db = new Database();
