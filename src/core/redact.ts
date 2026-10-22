export function redactError(error: unknown, secrets: readonly (string | undefined)[]): Error {
	const source = error instanceof Error ? error.message : String(error);
	let message = source;
	for (const secret of secrets) {
		if (secret && message.includes(secret)) message = message.split(secret).join("[redacted]");
	}
	const sanitized = new Error(message);
	if (error instanceof Error) sanitized.name = error.name;
	return sanitized;
}

export function redactDurable(value: unknown, secrets: readonly (string | undefined)[], replacement = "[redacted]"): unknown {
	if (typeof value === "string") {
		let redacted = value;
		for (const secret of secrets) {
			if (secret && redacted.includes(secret)) redacted = redacted.split(secret).join(replacement);
		}
		return redacted;
	}
	if (value instanceof Error) {
		const sanitized = redactError(value, secrets);
		if (value.stack) sanitized.stack = redactDurable(value.stack, secrets, replacement) as string;
		return sanitized;
	}
	if (Array.isArray(value)) return value.map((item) => redactDurable(item, secrets, replacement));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDurable(item, secrets, replacement)]));
}

