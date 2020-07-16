/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

/** @typedef {import("./Resolver").FileSystem} FileSystem */
/** @typedef {import("./Resolver").SyncFileSystem} SyncFileSystem */

const dirname = path => {
	let idx = path.length - 1;
	while (idx >= 0) {
		const c = path.charCodeAt(idx);
		// slash or backslash
		if (c === 47 || c === 92) break;
		idx--;
	}
	if (idx < 0) return "";
	return path.slice(0, idx);
};

const runCallbacks = (callbacks, err, result) => {
	if (callbacks.length === 1) return callbacks[0](err, result);
	let error;
	for (const callback of callbacks) {
		try {
			callback(err, result);
		} catch (e) {
			if (!error) error = e;
		}
	}
	callbacks.length = 0;
	if (error) throw error;
};

class OperationMergerBackend {
	/**
	 * @param {any} provider async method
	 * @param {any} syncProvider sync method
	 * @param {any} providerContext call context for the provider methods
	 */
	constructor(provider, syncProvider, providerContext) {
		this._provider = provider;
		this._syncProvider = syncProvider;
		this._providerContext = providerContext;
		this._activeAsyncOperations = new Map();

		this.provide = this._provider
			? (path, options, callback) => {
					if (typeof options === "function") {
						callback = options;
						options = undefined;
					}
					if (options) {
						return this._provider.call(
							this._providerContext,
							path,
							options,
							callback
						);
					}
					if (typeof path !== "string") {
						callback(new TypeError("path must be a string"));
						return;
					}
					let callbacks = this._activeAsyncOperations.get(path);
					if (callbacks) {
						callbacks.push(callback);
						return;
					}
					this._activeAsyncOperations.set(path, (callbacks = [callback]));
					provider(path, (err, result) => {
						this._activeAsyncOperations.delete(path);
						runCallbacks(callbacks, err, result);
					});
			  }
			: null;
		this.provideSync = this._syncProvider
			? (path, options) => {
					return this._syncProvider.call(this._providerContext, path, options);
			  }
			: null;
	}

	purge() {}
	purgeParent() {}
}

class Node {
	constructor(key, value) {
		this.key = key;
		this.value = value;
		this.next = null;
		this.prev = null;
	}
}

class LRUCache {
	constructor(capacity) {
		// this.cacheHits = 0;
		// this.cacheMisses = 0;
		this.cap = capacity;
		this.map = new Map();
		this.head = null;
		this.tail = null;
	}

	get(key) {
		const cachedNode = this.map.get(key);
		if (!cachedNode) {
			// this.cacheMisses += 1;
			return undefined;
		}

		// this.cacheHits += 1;
		this.removeNode(cachedNode);
		this.offerNode(cachedNode);

		return cachedNode.value;
	}

	put(key, value) {
		if (this.map.has(key)) {
			const cachedNode = this.map.get(key);
			cachedNode.value = value;

			//move to tail
			this.removeNode(cachedNode);
			this.offerNode(cachedNode);
		} else {
			if (this.map.size >= this.cap) {
				//delete head
				this.map.delete(this.head.key);
				this.removeNode(this.head);
			}

			//add to tail
			const node = new Node(key, value);
			this.offerNode(node);
			this.map.set(key, node);
		}
	}

	size() {
		return this.map.size;
	}

	purge() {
		// console.error(`Total cache hits: ${this.cacheHits}`);
		// console.error(`Total cache misses: ${this.cacheMisses}`);
		this.map = new Map();
		this.head = null;
		this.tail = null;
	}

	removeNode(node) {
		if (node.prev) {
			node.prev.next = node.next;
		} else {
			this.head = node.next;
		}

		if (node.next) {
			node.next.prev = node.prev;
		} else {
			this.tail = node.prev;
		}
	}

	offerNode(node) {
		if (this.tail) {
			this.tail.next = node;
		}

		node.prev = this.tail;
		node.next = null;
		this.tail = node;

		if (this.head === null) {
			this.head = this.tail;
		}
	}
}

class CacheBackend {
	/**
	 * @param {number} duration max cache duration of items
	 * @param {any} provider async method
	 * @param {any} syncProvider sync method
	 * @param {any} providerContext call context for the provider methods
	 */
	constructor(duration, provider, syncProvider, providerContext) {
		this._duration = duration;
		this._provider = provider;
		this._syncProvider = syncProvider;
		this._providerContext = providerContext;
		/** @type {Map<string, (function(Error, any): void)[]>} */
		this._activeAsyncOperations = new Map();
		this.lruCache = new LRUCache(duration);

		this.provide = this.provide.bind(this);
		this.provideSync = this.provideSync.bind(this);
	}

	provide(path, options, callback) {
		if (typeof options === "function") {
			callback = options;
			options = undefined;
		}
		if (typeof path !== "string") {
			callback(new TypeError("path must be a string"));
			return;
		}
		if (options) {
			return this._provider.call(
				this._providerContext,
				path,
				options,
				callback
			);
		}

		// Check in cache
		let cacheEntry = this.lruCache.get(path);
		if (cacheEntry !== undefined) {
			if (cacheEntry.err) return callback(cacheEntry.err);
			return callback(null, cacheEntry.result);
		}

		// Check if there is already the same operation running
		let callbacks = this._activeAsyncOperations.get(path);
		if (callbacks !== undefined) {
			callbacks.push(callback);
			return;
		}
		this._activeAsyncOperations.set(path, (callbacks = [callback]));

		// Run the operation
		this._provider.call(this._providerContext, path, (err, result) => {
			this._activeAsyncOperations.delete(path);
			this._storeResult(path, err, result);

			runCallbacks(callbacks, err, result);
		});
	}

	provideSync(path, options) {
		if (typeof path !== "string") {
			throw new TypeError("path must be a string");
		}
		if (options) {
			return this._syncProvider.call(this._providerContext, path, options);
		}

		// Check in cache
		let cacheEntry = this.lruCache.get(path);
		if (cacheEntry !== undefined) {
			if (cacheEntry.err) throw cacheEntry.err;
			return cacheEntry.result;
		}

		// Get all active async operations
		// This sync operation will also complete them
		const callbacks = this._activeAsyncOperations.get(path);
		this._activeAsyncOperations.delete(path);

		// Run the operation
		// When in idle mode, we will enter sync mode
		let result;
		try {
			result = this._syncProvider.call(this._providerContext, path);
		} catch (err) {
			this._storeResult(path, err, undefined);
			if (callbacks) runCallbacks(callbacks, err, undefined);
			throw err;
		}
		this._storeResult(path, undefined, result);
		if (callbacks) runCallbacks(callbacks, undefined, result);
		return result;
	}

	purge(what) {
		if (!what) {
			this.lruCache.purge();
		} else if (typeof what === "string") {
			this.lruCache.purge();
		} else {
			this.lruCache.purge();
		}
	}

	purgeParent(what) {
		if (!what) {
			this.purge();
		} else if (typeof what === "string") {
			this.purge(dirname(what));
		} else {
			const set = new Set();
			for (const item of what) {
				set.add(dirname(item));
			}
			this.purge(set);
		}
	}

	_storeResult(path, err, result) {
		this.lruCache.put(path, { err, result });
	}
}

const createBackend = (duration, provider, syncProvider, providerContext) => {
	if (duration > 0) {
		return new CacheBackend(duration, provider, syncProvider, providerContext);
	}
	return new OperationMergerBackend(provider, syncProvider, providerContext);
};

module.exports = class CachedInputFileSystem {
	constructor(fileSystem, duration) {
		this.fileSystem = fileSystem;

		this._statBackend = createBackend(
			duration,
			this.fileSystem.stat,
			this.fileSystem.statSync,
			this.fileSystem
		);
		this.stat = /** @type {FileSystem["stat"]} */ (this._statBackend.provide);
		this.statSync = /** @type {SyncFileSystem["statSync"]} */ (this._statBackend.provideSync);

		this._readdirBackend = createBackend(
			duration,
			this.fileSystem.readdir,
			this.fileSystem.readdirSync,
			this.fileSystem
		);
		this.readdir = /** @type {FileSystem["readdir"]} */ (this._readdirBackend.provide);
		this.readdirSync = /** @type {SyncFileSystem["readdirSync"]} */ (this._readdirBackend.provideSync);

		this._readFileBackend = createBackend(
			duration,
			this.fileSystem.readFile,
			this.fileSystem.readFileSync,
			this.fileSystem
		);
		this.readFile = /** @type {FileSystem["readFile"]} */ (this._readFileBackend.provide);
		this.readFileSync = /** @type {SyncFileSystem["readFileSync"]} */ (this._readFileBackend.provideSync);

		this._readJsonBackend = createBackend(
			duration,
			this.fileSystem.readJson ||
				(this.readFile &&
					((path, callback) => {
						// @ts-ignore
						this.readFile(path, (err, buffer) => {
							if (err) return callback(err);
							if (!buffer || buffer.length === 0)
								return callback(new Error("No file content"));
							let data;
							try {
								data = JSON.parse(buffer.toString("utf-8"));
							} catch (e) {
								return callback(e);
							}
							callback(null, data);
						});
					})),
			this.fileSystem.readJsonSync ||
				(this.readFileSync &&
					(path => {
						const buffer = this.readFileSync(path);
						const data = JSON.parse(buffer.toString("utf-8"));
						return data;
					})),
			this.fileSystem
		);
		this.readJson = /** @type {FileSystem["readJson"]} */ (this._readJsonBackend.provide);
		this.readJsonSync = /** @type {SyncFileSystem["readJsonSync"]} */ (this._readJsonBackend.provideSync);

		this._readlinkBackend = createBackend(
			duration,
			this.fileSystem.readlink,
			this.fileSystem.readlinkSync,
			this.fileSystem
		);
		this.readlink = /** @type {FileSystem["readlink"]} */ (this._readlinkBackend.provide);
		this.readlinkSync = /** @type {SyncFileSystem["readlinkSync"]} */ (this._readlinkBackend.provideSync);
	}

	purge(what) {
		this._statBackend.purge(what);
		this._readdirBackend.purgeParent(what);
		this._readFileBackend.purge(what);
		this._readlinkBackend.purge(what);
		this._readJsonBackend.purge(what);
	}
};
