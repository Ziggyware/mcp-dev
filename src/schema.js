// src/schema.js
//
// JSON Schema helpers shared by the argument form, the inline JSON editor,
// and the agent. Kept separate from suggest.js so the editor can validate
// without importing the agent runtime.

import Ajv from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const compiledSchemaCache = new Map();

function getValidator(schema) {
  const key = JSON.stringify(schema);
  let validate = compiledSchemaCache.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    compiledSchemaCache.set(key, validate);
  }
  return validate;
}

export function validateArguments(inputSchema, args) {
  if (!inputSchema || typeof inputSchema !== "object") return { valid: true, errors: [] };
  try {
    const validate = getValidator(inputSchema);
    const valid = validate(args);
    return {
      valid: Boolean(valid),
      errors: valid ? [] : (validate.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message}`),
    };
  } catch (error) {
    // A malformed server-provided schema must not turn into an opaque crash.
    return { valid: false, errors: [`Unable to validate the server schema: ${error.message}`] };
  }
}

export function schemaType(schema = {}) {
  if (Array.isArray(schema.type)) return schema.type.find((type) => type !== "null") ?? schema.type[0];
  if (schema.type) return schema.type;
  if (Array.isArray(schema.enum)) return "enum";
  if (schema.anyOf || schema.oneOf) return "variant";
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return "any";
}

export function schemaHint(schema = {}) {
  const details = [];
  if (schema.default !== undefined) details.push(`default: ${JSON.stringify(schema.default)}`);
  if (schema.format) details.push(schema.format);
  if (schema.minimum !== undefined) details.push(`min ${schema.minimum}`);
  if (schema.maximum !== undefined) details.push(`max ${schema.maximum}`);
  if (schema.pattern) details.push(`pattern ${schema.pattern}`);
  return details.length ? ` [${details.join(", ")}]` : "";
}

export function coerceScalar(value, schema) {
  const type = schemaType(schema);
  if (type === "number" || type === "integer") {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) throw new Error("Enter a finite number.");
    if (type === "integer" && !Number.isInteger(numeric)) throw new Error("Enter a whole number.");
    return numeric;
  }
  if (type === "null") {
    if (value === "null" || value === null) return null;
    throw new Error("Enter null.");
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function validateScalarText(value, schema, isRequired) {
  const text = String(value ?? "").trim();
  if (!text) return isRequired ? "A value is required." : true;
  try {
    const coerced = coerceScalar(text, schema);
    const fieldValidation = validateArguments(schema, coerced);
    return fieldValidation.valid ? true : fieldValidation.errors[0] ?? "Invalid value.";
  } catch (error) {
    return error.message;
  }
}

const PATH_PATTERN = /(^|[^a-z])(path|paths|file|files|filename|dir|directory|folder|root|target|source|cwd|workspace|location)([^a-z]|$)/i;
const JSON_PATTERN = /\b(json|object|config|payload|body|data|metadata|attributes|params)\b/i;

/** Heuristic: does this field name/description read as a filesystem path? */
export function isPathField(name, schema = {}) {
  if (schema.format === "uri" || schema.format === "uri-reference") return false;
  if (PATH_PATTERN.test(name)) return true;
  const description = String(schema.description ?? "");
  return /(absolute|relative)?\s*(file|directory|folder|path)\b/i.test(description) && !/url|uri/i.test(description);
}

/** Heuristic: should this field open the multi-line JSON editor by default? */
export function isJsonField(name, schema = {}) {
  const type = schemaType(schema);
  if (type === "array" || type === "object" || type === "variant") return true;
  if (JSON_PATTERN.test(name) && !Array.isArray(schema.enum)) return true;
  return false;
}

function placeholderFor(schema = {}, depth = 0) {
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.examples?.[0] !== undefined) return schema.examples[0];
  if (schema.const !== undefined) return schema.const;
  const type = schemaType(schema);
  if (type === "array") {
    const item = placeholderFor(schema.items ?? {}, depth + 1);
    return depth > 2 ? [] : [item];
  }
  if (type === "object" || type === "variant") {
    if (depth > 2) return {};
    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const out = {};
    for (const [key, value] of Object.entries(properties)) {
      const child = value ?? {};
      const childIsObject = ["object", "variant"].includes(schemaType(child)) || schemaType(child) === "array";
      // Nested containers are only included when required; scalar optionals are
      // included so the template documents the available keys.
      if (!required.has(key) && childIsObject) continue;
      out[key] = placeholderFor(child, depth + 1);
    }
    return out;
  }
  if (type === "boolean") return false;
  if (type === "number" || type === "integer") return 0;
  if (type === "null") return null;
  return schema.description ? "" : "";
}

/** A startable JSON template for a field, so the editor opens useful. */
export function schemaToTemplate(schema = {}) {
  try {
    return JSON.stringify(placeholderFor(schema), null, 2);
  } catch {
    return schemaType(schema) === "array" ? "[]" : "{}";
  }
}

/** One-line summary of a JSON value for compact displays. */
export function summarizeJson(value, { maxLength = 60 } = {}) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = "undefined";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
