import {
	createModels,
	createProvider,
	envApiKeyAuth,
	InMemoryCredentialStore,
	type Api,
	type ApiKeyAuth,
	type Model,
	type OpenAICompletionsCompat,
	type OpenAIResponsesCompat,
	type Provider,
	type ProviderEnv,
	type SimpleStreamOptions,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { Service } from "@deepseek-ai/cordis";

import type { AgentConnection, RegisteredModelProvider } from "../contracts.js";

export type OpenAICompatibleApi = "openai-completions" | "openai-responses";

export interface OpenAICompatibleModelConfig {
	readonly id: string;
	readonly name?: string;
	readonly api?: OpenAICompatibleApi;
	readonly reasoning?: boolean;
	readonly input?: readonly ("text" | "image")[];
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly compat?: OpenAICompletionsCompat | OpenAIResponsesCompat;
}

/**
 * Declarative, non-secret configuration for an OpenAI-compatible relay.
 * The API key arrives through apiKeyEnv, setCredential(), or a run-scoped
 * AgentConnection; an apiKey property in this object is rejected.
 */
export interface OpenAICompatibleProviderConfig {
	readonly id: string;
	readonly name?: string;
	readonly baseUrl: string;
	readonly apiKeyEnv?: string;
	readonly auth?: "api-key" | "none";
	readonly models: readonly OpenAICompatibleModelConfig[];
}

export interface ResolvedModelConnection {
	readonly model: Model<Api>;
	readonly stream: StreamFunction<Api, SimpleStreamOptions>;
}

export interface ModelCatalogEntry {
	readonly id: string;
	readonly name: string;
	readonly models: readonly {
		readonly id: string;
		readonly name: string;
		readonly api: string;
		readonly reasoning: boolean;
		readonly input: readonly ("text" | "image")[];
		readonly contextWindow: number;
		readonly maxTokens: number;
	}[];
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPENAI_APIS = new Set<OpenAICompatibleApi>(["openai-completions", "openai-responses"]);
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function nonEmpty(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(label + " must be a non-empty string.");
	return value.trim();
}

function endpoint(value: unknown): string {
	const text = nonEmpty(value, "OpenAI-compatible baseUrl");
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new Error("OpenAI-compatible baseUrl must be an absolute HTTP(S) URL.");
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
		throw new Error("OpenAI-compatible baseUrl must be an HTTP(S) URL without embedded credentials.");
	}
	return text.replace(/\/+$/, "");
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(label + " must be a positive integer.");
	return value as number;
}

function keylessAuth(): ApiKeyAuth {
	return {
		name: "No API key",
		check: async ({ signal }) => {
			signal.throwIfAborted();
			return { type: "api_key", source: "keyless endpoint" };
		},
		resolve: async ({ signal }) => {
			signal.throwIfAborted();
			return { auth: {}, source: "keyless endpoint" };
		},
	};
}

function normalizeOpenAICompatibleConfig(config: OpenAICompatibleProviderConfig): OpenAICompatibleProviderConfig {
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error("OpenAI-compatible provider config must be an object.");
	}
	if (Object.hasOwn(config, "apiKey")) {
		throw new Error("OpenAI-compatible config stores only apiKeyEnv; pass the API key as a runtime credential.");
	}
	const id = nonEmpty(config.id, "OpenAI-compatible provider id");
	if (!PROVIDER_ID.test(id)) throw new Error("Invalid OpenAI-compatible provider id: " + id);
	const baseUrl = endpoint(config.baseUrl);
	const name = config.name === undefined ? id : nonEmpty(config.name, "OpenAI-compatible provider name");
	if (config.apiKeyEnv !== undefined && !ENV_NAME.test(config.apiKeyEnv)) {
		throw new Error("Invalid API key environment variable name: " + config.apiKeyEnv);
	}
	if (config.auth !== undefined && config.auth !== "api-key" && config.auth !== "none") {
		throw new Error("OpenAI-compatible auth must be api-key or none.");
	}
	if (!Array.isArray(config.models) || config.models.length === 0) {
		throw new Error("OpenAI-compatible provider needs at least one model.");
	}
	const modelIds = new Set<string>();
	const models = config.models.map((candidate, index) => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
			throw new Error("OpenAI-compatible model " + (index + 1) + " must be an object.");
		}
		const modelId = nonEmpty(candidate.id, "OpenAI-compatible model " + (index + 1) + " id");
		if (modelIds.has(modelId)) throw new Error("Duplicate OpenAI-compatible model id: " + modelId);
		modelIds.add(modelId);
		const api = candidate.api ?? "openai-completions";
		if (!OPENAI_APIS.has(api)) throw new Error("Unsupported OpenAI-compatible API: " + String(api));
		const input = candidate.input === undefined ? ["text"] as const : [...candidate.input];
		if (input.length === 0 || input.some((item) => item !== "text" && item !== "image")) {
			throw new Error("OpenAI-compatible model " + modelId + " has invalid input capabilities.");
		}
		return Object.freeze({
			id: modelId,
			name: candidate.name === undefined ? modelId : nonEmpty(candidate.name, "OpenAI-compatible model " + modelId + " name"),
			api,
			reasoning: candidate.reasoning ?? false,
			input: Object.freeze(input),
			contextWindow: positiveInteger(candidate.contextWindow, 128_000, modelId + " contextWindow"),
			maxTokens: positiveInteger(candidate.maxTokens, 16_384, modelId + " maxTokens"),
			...(candidate.compat === undefined ? {} : { compat: structuredClone(candidate.compat) }),
		});
	});
	return Object.freeze({
		id,
		name,
		baseUrl,
		...(config.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.apiKeyEnv }),
		auth: config.auth ?? "api-key",
		models: Object.freeze(models),
	});
}

/** Build one real Pi AI Provider from a non-secret relay declaration. */
export function createOpenAICompatibleProvider(config: OpenAICompatibleProviderConfig): Provider<OpenAICompatibleApi> {
	const normalized = normalizeOpenAICompatibleConfig(config);
	const models: Model<OpenAICompatibleApi>[] = normalized.models.map((model) => ({
		id: model.id,
		name: model.name ?? model.id,
		api: model.api ?? "openai-completions",
		provider: normalized.id,
		baseUrl: normalized.baseUrl,
		reasoning: model.reasoning ?? false,
		input: [...(model.input ?? ["text"])],
		cost: { ...ZERO_COST },
		contextWindow: model.contextWindow ?? 128_000,
		maxTokens: model.maxTokens ?? 16_384,
		...(model.compat === undefined ? {} : { compat: structuredClone(model.compat) as never }),
	}));
	const auth = normalized.auth === "none"
		? keylessAuth()
		: envApiKeyAuth(normalized.name + " API key", normalized.apiKeyEnv ? [normalized.apiKeyEnv] : []);
	return createProvider({
		id: normalized.id,
		name: normalized.name ?? normalized.id,
		baseUrl: normalized.baseUrl,
		auth: { apiKey: auth },
		models,
		api: {
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}

function adHocOpenAIProvider(connection: AgentConnection): Provider<OpenAICompatibleApi> {
	return createOpenAICompatibleProvider({
		id: connection.provider,
		name: connection.provider,
		baseUrl: connection.baseUrl!,
		// A relay has no reliable capability catalog. Preserve explicitly supplied
		// images in the request and let the endpoint accept or reject them.
		models: [{ id: connection.model, input: ["text", "image"] }],
	});
}

/** DSH-shaped ctx.llm seam backed by Pi AI provider adapters. */
export class LlmRuntime extends Service {
	private readonly credentials = new InMemoryCredentialStore();
	readonly pi = createModels({ credentials: this.credentials });
	private readonly providers = new Map<string, RegisteredModelProvider>();

	constructor(ctx: import("@deepseek-ai/cordis").Context) {
		super(ctx, "llm");
	}

	register(provider: Provider, owner = "anonymous"): () => void {
		if (this.providers.has(provider.id)) throw new Error("Model provider already registered: " + provider.id);
		const entry = Object.freeze({ provider, owner });
		this.providers.set(provider.id, entry);
		this.pi.setProvider(provider);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			if (this.providers.get(provider.id) === entry) {
				this.providers.delete(provider.id);
				this.pi.deleteProvider(provider.id);
			}
		};
	}

	/** Transactional bulk registration used by the Pi built-in catalog plugin. */
	registerMany(providers: readonly Provider[], owner = "anonymous"): () => void {
		const dispose: Array<() => void> = [];
		try {
			for (const provider of providers) dispose.push(this.register(provider, owner));
		} catch (error) {
			for (const unregister of dispose.reverse()) unregister();
			throw error;
		}
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			for (const unregister of dispose.reverse()) unregister();
		};
	}

	resolve(providerId: string, modelId: string): Model<Api> {
		const model = this.pi.getModel(providerId, modelId);
		if (!model) {
			const available = this.pi.getModels(providerId).map((candidate) => candidate.id);
			throw new Error(
				"Model " + providerId + "/" + modelId + " is unavailable. Registered models: " + (available.join(", ") || "(none)") + ".",
			);
		}
		return model;
	}

	/**
	 * Resolve one run without mutating global provider/auth state. A base URL
	 * overrides only that run; an unknown provider plus base URL gets an
	 * ephemeral OpenAI Chat Completions adapter.
	 */
	resolveConnection(connection: AgentConnection): ResolvedModelConnection {
		const providerId = nonEmpty(connection.provider, "Connection provider");
		const modelId = nonEmpty(connection.model, "Connection model");
		if (connection.apiKey !== undefined && connection.apiKey.trim().length === 0) {
			throw new Error("Connection API key must not be empty.");
		}
		const baseUrl = connection.baseUrl === undefined ? undefined : endpoint(connection.baseUrl);
		const registeredModel = this.pi.getModel(providerId, modelId);
		if (registeredModel) {
			const model = baseUrl === undefined ? registeredModel : { ...registeredModel, baseUrl };
			return {
				model,
				stream: (requestModel, context, options) => this.pi.streamSimple(requestModel, context, {
					...options,
					...(connection.apiKey === undefined ? {} : { apiKey: connection.apiKey }),
				}),
			};
		}
		// A provider's static catalog is a convenience list, not a ceiling. Model
		// aliases often change before the bundled catalog does; retain the native
		// provider protocol (Anthropic, OpenAI, Bedrock, etc.) for a manually
		// entered model ID instead of incorrectly falling back to Chat Completions.
		const registeredProvider = this.providers.get(providerId)?.provider;
		const template = registeredProvider?.getModels()[0];
		if (template) {
			const model = {
				...template,
				id: modelId,
				name: modelId,
				...(baseUrl === undefined ? {} : { baseUrl }),
			};
			return {
				model,
				stream: (requestModel, context, options) => this.pi.streamSimple(requestModel, context, {
					...options,
					...(connection.apiKey === undefined ? {} : { apiKey: connection.apiKey }),
				}),
			};
		}
		if (baseUrl === undefined) return { model: this.resolve(providerId, modelId), stream: this.pi.streamSimple.bind(this.pi) };
		const provider = adHocOpenAIProvider({ ...connection, provider: providerId, model: modelId, baseUrl });
		const model = provider.getModels()[0]!;
		return {
			model,
			stream: (requestModel, context, options) => provider.streamSimple(requestModel as Model<OpenAICompatibleApi>, context, {
				...options,
				...(connection.apiKey === undefined ? {} : { apiKey: connection.apiKey }),
			}),
		};
	}

	list(): readonly RegisteredModelProvider[] {
		return [...this.providers.values()].sort((left, right) => left.provider.id.localeCompare(right.provider.id));
	}

	listModels(providerId?: string): readonly Model<Api>[] {
		return [...this.pi.getModels(providerId)].sort(
			(left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
		);
	}

	/** Stable, non-secret DTO for Desktop/provider pickers. */
	catalog(): readonly ModelCatalogEntry[] {
		return this.list().map(({ provider }) => ({
			id: provider.id,
			name: provider.name,
			models: this.listModels(provider.id).map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: [...model.input],
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			})),
		}));
	}

	/** Process-local credential injection; no profile or session write occurs. */
	async setCredential(providerId: string, apiKey: string, env?: Readonly<ProviderEnv>): Promise<void> {
		const id = nonEmpty(providerId, "Credential provider");
		if (apiKey.trim().length === 0) throw new Error("API key must not be empty.");
		const normalizedEnv = env === undefined ? undefined : Object.fromEntries(
			Object.entries(env).map(([name, value]) => {
				if (!ENV_NAME.test(name) || typeof value !== "string") throw new Error("Invalid provider environment value: " + name);
				return [name, value];
			}),
		);
		await this.credentials.modify(id, async () => ({
			type: "api_key",
			key: apiKey,
			...(normalizedEnv === undefined ? {} : { env: normalizedEnv }),
		}));
	}

	async deleteCredential(providerId: string): Promise<void> {
		await this.credentials.delete(nonEmpty(providerId, "Credential provider"));
	}

	async authSummary(providerId: string): Promise<string> {
		const status = await this.pi.checkAuth(providerId);
		if (!status) return "provider is not registered or configured";
		return status.type + " from " + (status.source ?? "provider auth");
	}
}

/** @deprecated Use LlmRuntime; retained for source compatibility. */
export { LlmRuntime as ModelRegistry };
