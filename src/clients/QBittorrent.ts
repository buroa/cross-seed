import { fileFrom } from "fetch-blob/from.js";
import { FormData } from "formdata-polyfill/esm.min.js";
import { unlink, writeFile } from "fs/promises";
import fetch, { BodyInit, Response } from "node-fetch";
import { tmpdir } from "os";
import parseTorrent, { Metafile } from "parse-torrent";
import { dirname, join } from "path";
import { InjectionResult } from "../constants.js";
import { CrossSeedError } from "../errors.js";
import { Label, logger } from "../logger.js";
import { getRuntimeConfig } from "../runtimeConfig.js";
import { Searchee } from "../searchee.js";
import { isSingleFileTorrent } from "../torrent.js";
import { TorrentClient } from "./TorrentClient.js";

const X_WWW_FORM_URLENCODED = {
	"Content-Type": "application/x-www-form-urlencoded",
};

interface SearchResult {
	added_on: number;
	amount_left: number;
	auto_tmm: boolean;
	availability: number;
	category: string;
	completed: number;
	completion_on: number;
	content_path: string;
	dl_limit: number;
	dlspeed: number;
	download_path: string;
	downloaded: number;
	downloaded_session: number;
	eta: number;
	f_l_piece_prio: boolean;
	force_start: boolean;
	hash: string;
	infohash_v1: string;
	infohash_v2: string;
	last_activity: number;
	magnet_uri: string;
	max_ratio: number;
	max_seeding_time: number;
	name: string;
	num_complete: number;
	num_incomplete: number;
	num_leechs: number;
	num_seeds: number;
	priority: number;
	progress: number;
	ratio: number;
	ratio_limit: number;
	save_path: string;
	seeding_time: number;
	seeding_time_limit: number;
	seen_complete: number;
	seq_dl: boolean;
	size: number;
	state: string;
	super_seeding: boolean;
	tags: string;
	time_active: number;
	total_size: number;
	tracker: string;
	trackers_count: number;
	up_limit: number;
	uploaded: number;
	uploaded_session: number;
	upspeed: number;
}

export default class QBittorrent implements TorrentClient {
	url: URL;
	cookie: string;

	constructor() {
		const { qbittorrentUrl } = getRuntimeConfig();
		try {
			this.url = new URL(`${qbittorrentUrl}/api/v2`);
		} catch (e) {
			throw new CrossSeedError("qBittorrent url must be percent-encoded");
		}
	}

	async login(): Promise<void> {
		const { origin, pathname, username, password } = this.url;

		let searchParams;
		try {
			searchParams = new URLSearchParams({
				username: decodeURIComponent(username),
				password: decodeURIComponent(password),
			});
		} catch (e) {
			throw new CrossSeedError("qBittorrent url must be percent-encoded");
		}

		let response: Response;
		try {
			response = await fetch(
				`${origin}${pathname}/auth/login?${searchParams}`
			);
		} catch (e) {
			throw new CrossSeedError(`qBittorrent login failed: ${e.message}`);
		}

		if (response.status !== 200) {
			throw new CrossSeedError(
				`qBittorrent login failed with code ${response.status}`
			);
		}

		const cookieArray = response.headers.raw()["set-cookie"];
		if (cookieArray) {
			this.cookie = cookieArray[0].split(";")[0];
		} else {
			throw new CrossSeedError(
				`qBittorrent login failed: Invalid username or password`
			);
		}
	}

	async validateConfig(): Promise<void> {
		await this.login();
		await this.createTag();
	}

	private async request(
		path: string,
		body: BodyInit,
		headers: Record<string, string> = {},
		retries = 1
	): Promise<string> {
		logger.verbose({
			label: Label.QBITTORRENT,
			message: `Making request to ${path} with body ${body.toString()}`,
		});
		const { origin, pathname } = this.url;
		const response = await fetch(`${origin}${pathname}${path}`, {
			method: "post",
			headers: { Cookie: this.cookie, ...headers },
			body,
		});
		if (response.status === 403 && retries > 0) {
			logger.verbose({
				label: Label.QBITTORRENT,
				message: "received 403 from API. Logging in again and retrying",
			});
			await this.login();
			return this.request(path, body, headers, retries - 1);
		}
		return response.text();
	}

	async createTag(): Promise<void> {
		await this.request(
			"/torrents/createTags",
			"tags=cross-seed",
			X_WWW_FORM_URLENCODED
		);
	}

	async isInfoHashInClient(infoHash: string): Promise<boolean> {
		const responseText = await this.request(
			"/torrents/properties",
			`hash=${infoHash}`,
			X_WWW_FORM_URLENCODED
		);
		try {
			const properties = JSON.parse(responseText);
			return properties && typeof properties === "object";
		} catch (e) {
			return false;
		}
	}

	async getTorrentConfiguration(searchee: Searchee): Promise<{
		save_path: string;
		isComplete: boolean;
		autoTMM: boolean;
		category: string;
		content_path: string;
	}> {
		const responseText = await this.request(
			"/torrents/info",
			`hashes=${searchee.infoHash}`,
			X_WWW_FORM_URLENCODED
		);
		const searchResult = JSON.parse(responseText).find(
			(e) => e.hash === searchee.infoHash
		) as SearchResult;
		if (searchResult === undefined) {
			throw new Error(
				"Failed to retrieve data dir; torrent not found in client"
			);
		}

		const { progress, save_path, auto_tmm, category, content_path } =
			searchResult;
		return {
			save_path,
			isComplete: progress === 1,
			autoTMM: auto_tmm,
			category,
			content_path,
		};
	}

	async inject(
		newTorrent: Metafile,
		searchee: Searchee
	): Promise<InjectionResult> {
		if (await this.isInfoHashInClient(newTorrent.infoHash)) {
			return InjectionResult.ALREADY_EXISTS;
		}
		const buf = parseTorrent.toTorrentFile(newTorrent);
		const filename = `${newTorrent.name}.cross-seed.torrent`;
		const tempFilepath = join(tmpdir(), filename);
		await writeFile(tempFilepath, buf, { mode: 0o644 });
		try {
			const { save_path, isComplete, autoTMM, category, content_path } =
				await this.getTorrentConfiguration(searchee);

			if (!isComplete) return InjectionResult.TORRENT_NOT_COMPLETE;

			const shouldManuallyEnforceContentLayout =
				isSingleFileTorrent(newTorrent) &&
				dirname(content_path) !== save_path;

			const file = await fileFrom(
				tempFilepath,
				"application/x-bittorrent"
			);
			const formData = new FormData();
			formData.append("torrents", file, filename);
			formData.append("tags", "cross-seed");
			formData.append("category", category);
			if (autoTMM) {
				formData.append("autoTMM", "true");
			} else {
				formData.append("autoTMM", "false");
				formData.append("savepath", save_path);
			}
			if (shouldManuallyEnforceContentLayout) {
				formData.append("contentLayout", "Subfolder");
				formData.append("skip_checking", "false");
				formData.append("paused", "true");
			} else {
				formData.append("skip_checking", "true");
				formData.append("paused", "false");
			}

			// for some reason the parser parses the last kv pair incorrectly
			// it concats the value and the sentinel
			formData.append("foo", "bar");

			await this.request("/torrents/add", formData);

			if (shouldManuallyEnforceContentLayout) {
				await this.request(
					"/torrents/recheck",
					`hashes=${newTorrent.infoHash}`,
					X_WWW_FORM_URLENCODED
				);
				await this.request(
					"/torrents/resume",
					`hashes=${newTorrent.infoHash}`,
					X_WWW_FORM_URLENCODED
				);
			}

			unlink(tempFilepath).catch((error) => {
				logger.debug(error);
			});

			return InjectionResult.SUCCESS;
		} catch (e) {
			logger.debug({
				label: Label.QBITTORRENT,
				message: `injection failed: ${e.message}`,
			});
			return InjectionResult.FAILURE;
		}
	}
}
