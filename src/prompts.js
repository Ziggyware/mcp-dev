import {
  createPrompt,
  isBackspaceKey,
  isDownKey,
  isEnterKey,
  isTabKey,
  isUpKey,
  makeTheme,
  Separator,
  useEffect,
  useKeypress,
  useMemo,
  usePagination,
  usePrefix,
  useState,
} from "@inquirer/core";
import { confirm, select } from "@inquirer/prompts";

const inputTheme = { validationFailureMode: "keep" };
const searchTheme = {
  helpMode: "always",
  style: {
    keysHelpTip: (keys) => keys.map(([key, action]) => `${key} ${action}`).join("  •  "),
  },
};

function isWordCharacter(char) {
  return /[\p{L}\p{N}_]/u.test(char);
}

/**
 * Return a line with the word before cursor removed. Kept pure both for tests
 * and as a fallback on Node versions without readline's private helper.
 */
export function deleteWordBeforeCursor(line, cursor = String(line).length) {
  const text = String(line ?? "");
  const at = Math.max(0, Math.min(Number(cursor) || 0, text.length));
  let start = at;

  while (start > 0 && /\s/.test(text[start - 1])) start--;
  if (start > 0) {
    const word = isWordCharacter(text[start - 1]);
    while (start > 0 && !/\s/.test(text[start - 1]) && isWordCharacter(text[start - 1]) === word) start--;
  }

  return {
    line: text.slice(0, start) + text.slice(at),
    cursor: start,
  };
}

export function isWordDeleteKey(key) {
  return Boolean(
    key && (
      (isBackspaceKey(key) && (key.ctrl || key.meta)) ||
      (key.ctrl && key.name === "w")
    )
  );
}

function applyWordDelete(rl) {
  const next = deleteWordBeforeCursor(rl.line, rl.cursor);
  if (typeof rl._deleteWordLeft === "function") {
    // readline's own implementation preserves terminal wrapping/cursor state.
    // We have already normalized Ctrl+Backspace to this action below.
    rl._deleteWordLeft();
    return;
  }

  rl.line = next.line;
  rl.cursor = next.cursor;
  if (typeof rl._refreshLine === "function") {
    rl._refreshLine();
    return;
  }

  // Last-resort fallback for unusual readline implementations.
  rl.clearLine(0);
  rl.write(next.line);
  for (let i = next.line.length; i > next.cursor; i--) rl.write(null, { name: "left" });
}

/**
 * Node treats Ctrl+W as delete-word but many Windows terminals expose
 * Ctrl+Backspace as a ctrl+backspace key event, which readline treats as one
 * character. Install a prepended listener so both forms work uniformly.
 */
function useWordDeleteShortcut() {
  useEffect((rl) => {
    const handler = (_input, key) => {
      if (!isWordDeleteKey(key)) return;
      applyWordDelete(rl);
      // readline's own keypress handler runs after this prepended listener.
      // Neutralize the event so it does not delete a second character.
      // `readline` falls back to inserting the original input string for an
      // unknown key name. Escape is a recognized no-op key, so the default
      // handler will leave the line we just edited alone.
      key.name = "escape";
      key.sequence = "\u001b";
      key.ctrl = false;
      key.meta = false;
    };
    rl.input.prependListener("keypress", handler);
    return () => rl.input.removeListener("keypress", handler);
  }, []);
}

/** Input prompt with Ctrl+Backspace/Ctrl+W word deletion. */
export const textInput = createPrompt((config, done) => {
  const { prefill = "tab" } = config;
  const theme = makeTheme(inputTheme, config.theme);
  const [status, setStatus] = useState("idle");
  const [defaultValue = "", setDefaultValue] = useState(config.default);
  const [errorMsg, setError] = useState();
  const [value, setValue] = useState("");
  const prefix = usePrefix({ status, theme });

  useWordDeleteShortcut();

  async function validate(answer) {
    const { required, pattern, patternError = "Invalid input" } = config;
    if (required && !answer) return "You must provide a value";
    if (pattern && !pattern.test(answer)) return patternError;
    if (typeof config.validate === "function") {
      return (await config.validate(answer)) || "You must provide a valid value";
    }
    return true;
  }

  useKeypress(async (key, rl) => {
    if (status !== "idle") return;
    if (isEnterKey(key)) {
      const answer = value || defaultValue;
      setStatus("loading");
      const valid = await validate(answer);
      if (valid === true) {
        setValue(answer);
        setStatus("done");
        done(answer);
      } else {
        if (theme.validationFailureMode === "clear") setValue("");
        else rl.write(value);
        setError(valid);
        setStatus("idle");
      }
    } else if (isBackspaceKey(key) && !value) {
      setDefaultValue(undefined);
    } else if (isTabKey(key) && !value) {
      setDefaultValue(undefined);
      rl.clearLine(0);
      rl.write(defaultValue);
      setValue(defaultValue);
    } else {
      setValue(rl.line);
      setError(undefined);
    }
  });

  useEffect((rl) => {
    if (prefill === "editable" && defaultValue) {
      rl.write(defaultValue);
      setValue(defaultValue);
    }
  }, []);

  const message = theme.style.message(config.message, status);
  const formattedValue = typeof config.transformer === "function"
    ? config.transformer(value, { isFinal: status === "done" })
    : status === "done" ? theme.style.answer(value) : value;
  const defaultStr = defaultValue && status !== "done" && !value
    ? theme.style.defaultAnswer(defaultValue)
    : undefined;
  const error = errorMsg ? theme.style.error(errorMsg) : "";

  return [
    [prefix, message, defaultStr, formattedValue].filter((part) => part !== undefined).join(" "),
    error,
  ];
});

function isSelectable(item) {
  return !Separator.isSeparator(item) && !item.disabled;
}

function normalizeChoices(choices) {
  return choices.map((choice) => {
    if (Separator.isSeparator(choice)) return choice;
    if (typeof choice === "string") {
      return { value: choice, name: choice, short: choice, disabled: false };
    }
    const name = choice.name ?? String(choice.value);
    return {
      value: choice.value,
      name,
      short: choice.short ?? name,
      disabled: choice.disabled ?? false,
      ...(choice.description ? { description: choice.description } : {}),
    };
  });
}

/** Search prompt with the same Ctrl+Backspace behavior as textInput. */
export const wordSearch = createPrompt((config, done) => {
  const { pageSize = 7, validate = () => true } = config;
  const theme = makeTheme(searchTheme, config.theme);
  const [status, setStatus] = useState("loading");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchError, setSearchError] = useState();
  const prefix = usePrefix({ status, theme });

  useWordDeleteShortcut();

  const bounds = useMemo(() => ({
    first: searchResults.findIndex(isSelectable),
    last: searchResults.findLastIndex(isSelectable),
  }), [searchResults]);
  const [active = bounds.first, setActive] = useState();

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    setSearchError(undefined);
    const fetchResults = async () => {
      try {
        const choices = await config.source(searchTerm || undefined, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setActive(undefined);
          setSearchResults(normalizeChoices(choices));
          setStatus("idle");
        }
      } catch (error) {
        if (!controller.signal.aborted && error instanceof Error) setSearchError(error.message);
      }
    };
    void fetchResults();
    return () => controller.abort();
  }, [searchTerm]);

  const selectedChoice = searchResults[active];
  useKeypress(async (key, rl) => {
    if (isEnterKey(key)) {
      if (selectedChoice) {
        setStatus("loading");
        const valid = await validate(selectedChoice.value);
        setStatus("idle");
        if (valid === true) {
          setStatus("done");
          done(selectedChoice.value);
        } else if (selectedChoice.name === searchTerm) {
          setSearchError(valid || "You must provide a valid value");
        } else {
          rl.write(selectedChoice.name);
          setSearchTerm(selectedChoice.name);
        }
      } else {
        rl.write(searchTerm);
      }
    } else if (isTabKey(key) && selectedChoice) {
      rl.clearLine(0);
      rl.write(selectedChoice.name);
      setSearchTerm(selectedChoice.name);
    } else if (status !== "loading" && (isUpKey(key) || isDownKey(key))) {
      rl.clearLine(0);
      if ((isUpKey(key) && active !== bounds.first) || (isDownKey(key) && active !== bounds.last)) {
        const offset = isUpKey(key) ? -1 : 1;
        let next = active;
        do {
          next = (next + offset + searchResults.length) % searchResults.length;
        } while (!isSelectable(searchResults[next]));
        setActive(next);
      }
    } else {
      setSearchTerm(rl.line);
    }
  });

  const message = theme.style.message(config.message, status);
  const helpLine = theme.style.keysHelpTip([
    ["↑↓", "navigate"],
    ["Enter", "select"],
    ["Ctrl+Backspace", "delete word"],
  ]);
  const page = usePagination({
    items: searchResults,
    active,
    renderItem({ item, isActive }) {
      if (Separator.isSeparator(item)) return ` ${item.separator}`;
      if (item.disabled) {
        const label = typeof item.disabled === "string" ? item.disabled : "(disabled)";
        return `- ${item.name} ${label}`;
      }
      return `${isActive ? ">" : " "} ${item.name}`;
    },
    pageSize,
    loop: false,
  });

  if (status === "done" && selectedChoice) {
    return [prefix, message, theme.style.answer(selectedChoice.short)].filter(Boolean).join(" ").trimEnd();
  }

  const error = searchError ?? (searchResults.length === 0 && searchTerm !== "" && status === "idle" ? "No results found" : "");
  const description = selectedChoice?.description ?? "";
  const header = [prefix, message, searchTerm].filter(Boolean).join(" ").trimEnd();
  const body = [error || page, " ", description, helpLine].filter(Boolean).join("\n").trimEnd();
  return [header, body];
});

export { confirm, select, Separator };
