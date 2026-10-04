// test/helpers/vterm.js
//
// A small ANSI terminal emulator for the pty tests. The session UI paints an
// alternate screen with absolute cursor moves, so asserting on the raw byte
// stream cannot tell "the caret is on the input row" from "the caret is three
// rows up" — and it cannot see that a repaint overwrote an earlier result.
// Feeding the stream through this grid makes those regressions directly
// testable: `term.text()`, `term.row`, `term.col`, and `term.inAlt`.
//
// It intentionally implements only the subset the CLI uses: CUP/CUU/CUD/CUF/
// CUB, EL, ED, CR/LF/BS, SGR (colors are dropped), the alternate buffer, and
// mouse-mode tracking. Everything else is ignored the way a terminal would.

const CSI_RE = /^\x1b\[([0-9;?<=>!]*)([@-~])/;

export class VTerm {
  constructor({ rows = 24, cols = 80 } = {}) {
    this.rows = rows;
    this.cols = cols;
    this.main = this._blank();
    this.alt = null;
    this.grid = this.main;
    this.row = 0;
    this.col = 0;
    this.inAlt = false;
    this.cursorVisible = true;
    this.mouseMode = false;
    this._pending = "";
  }

  _blank() {
    return Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, () => " "));
  }

  /** One screen row with trailing blanks removed. */
  line(index) {
    return (this.grid[index] ?? []).join("").replace(/\s+$/, "");
  }

  /** The whole screen as text, trailing blank rows removed. */
  text() {
    const lines = [];
    for (let index = 0; index < this.rows; index++) lines.push(this.line(index));
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }

  /** Occurrences of `needle` anywhere on the screen (across row joins). */
  includes(needle) {
    return this.text().includes(needle);
  }

  resize(rows, cols) {
    const previous = this.grid;
    this.rows = rows;
    this.cols = cols;
    this.grid = Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => previous[r]?.[c] ?? " "));
    if (this.alt) this.alt = this.grid;
    this.row = Math.min(this.row, rows - 1);
    this.col = Math.min(this.col, cols - 1);
  }

  _scroll() {
    this.grid.shift();
    this.grid.push(Array.from({ length: this.cols }, () => " "));
  }

  write(data) {
    const text = this._pending + String(data);
    this._pending = "";
    let index = 0;
    while (index < text.length) {
      const char = text[index];
      if (char === "\x1b") {
        const consumed = this._escape(text, index);
        if (consumed === -1) {
          // Incomplete sequence: keep it for the next chunk.
          this._pending = text.slice(index);
          return this;
        }
        index = consumed;
        continue;
      }
      if (char === "\r") { this.col = 0; index += 1; continue; }
      if (char === "\n") {
        this.col = 0;
        if (this.row === this.rows - 1) this._scroll();
        else this.row += 1;
        index += 1;
        continue;
      }
      if (char === "\b") { this.col = Math.max(0, this.col - 1); index += 1; continue; }
      if (char === "\x07") { index += 1; continue; }
      if (char === "\t") {
        const next = Math.min(this.cols - 1, this.col + (8 - (this.col % 8)));
        while (this.col < next) this.grid[this.row][this.col++] = " ";
        index += 1;
        continue;
      }
      this._put(char);
      index += 1;
    }
    return this;
  }

  _put(char) {
    if (this.col >= this.cols) {
      this.col = 0;
      if (this.row === this.rows - 1) this._scroll();
      else this.row += 1;
    }
    if (this.col < 0) this.col = 0;
    this.grid[this.row][this.col] = char;
    this.col = this.col === this.cols - 1 ? this.cols : this.col + 1;
  }

  /** Returns the index after the sequence, or -1 when the chunk is incomplete. */
  _escape(text, start) {
    const rest = text.slice(start);
    if (rest.length === 1) return -1;
    const second = rest[1];
    if (second === "[") {
      const match = CSI_RE.exec(rest);
      if (match) {
        this._csi(match[1], match[2]);
        return start + match[0].length;
      }
      // Incomplete CSI: more bytes may arrive.
      if (!/[@-~]/.test(rest.slice(2))) return -1;
      // Unknown but complete: swallow up to the final byte.
      const finalIndex = rest.slice(2).search(/[@-~]/);
      return start + 2 + finalIndex + 1;
    }
    if (second === "]") {
      const end = rest.indexOf("\x07");
      if (end === -1) return -1;
      return start + end + 1;
    }
    return start + 2;
  }

  _csi(params, final) {
    if (params.startsWith("?")) {
      for (const mode of params.slice(1).split(";")) {
        if (mode === "1049" || mode === "47") {
          if (final === "h") {
            this.alt = this._blank();
            this.grid = this.alt;
            this.row = 0;
            this.col = 0;
            this.inAlt = true;
          } else if (final === "l") {
            this.grid = this.main;
            this.inAlt = false;
          }
        } else if (mode === "25") {
          this.cursorVisible = final === "h";
        } else if (mode === "1000" || mode === "1002" || mode === "1003" || mode === "1006") {
          this.mouseMode = final === "h";
        }
      }
      return;
    }
    const args = params.split(";").map((value) => (value === "" ? null : Number(value)));
    const n = (index, fallback = 1) => (args[index] === null || args[index] === undefined ? fallback : args[index]);
    switch (final) {
      case "H":
      case "f":
        this.row = clamp(n(0) - 1, 0, this.rows - 1);
        this.col = clamp(n(1) - 1, 0, this.cols - 1);
        break;
      case "A": this.row = clamp(this.row - n(0), 0, this.rows - 1); break;
      case "B": this.row = clamp(this.row + n(0), 0, this.rows - 1); break;
      case "C": this.col = clamp(this.col + n(0), 0, this.cols - 1); break;
      case "D": this.col = clamp(this.col - n(0), 0, this.cols - 1); break;
      case "E": this.row = clamp(this.row + n(0), 0, this.rows - 1); this.col = 0; break;
      case "F": this.row = clamp(this.row - n(0), 0, this.rows - 1); this.col = 0; break;
      case "G": this.col = clamp(n(0) - 1, 0, this.cols - 1); break;
      case "d": this.row = clamp(n(0) - 1, 0, this.rows - 1); break;
      case "K": {
        const mode = args[0] ?? 0;
        if (mode === 0) for (let c = this.col; c < this.cols; c++) this.grid[this.row][c] = " ";
        if (mode === 1) for (let c = 0; c <= this.col; c++) this.grid[this.row][c] = " ";
        if (mode === 2) for (let c = 0; c < this.cols; c++) this.grid[this.row][c] = " ";
        break;
      }
      case "J": {
        const mode = args[0] ?? 0;
        if (mode === 0) {
          for (let c = this.col; c < this.cols; c++) this.grid[this.row][c] = " ";
          for (let r = this.row + 1; r < this.rows; r++) for (let c = 0; c < this.cols; c++) this.grid[r][c] = " ";
        } else if (mode === 1) {
          for (let r = 0; r < this.row; r++) for (let c = 0; c < this.cols; c++) this.grid[r][c] = " ";
          for (let c = 0; c <= this.col; c++) this.grid[this.row][c] = " ";
        } else {
          for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) this.grid[r][c] = " ";
        }
        break;
      }
      case "S": for (let k = 0; k < n(0); k++) this._scroll(); break;
      default: break;
    }
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\r/g, "\n");
}
