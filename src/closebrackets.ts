/* eslint-disable prefer-const, eqeqeq, no-param-reassign, @typescript-eslint/strict-boolean-expressions, unicorn/prefer-code-point */
import { syntaxTree } from '@codemirror/language';
import {
  EditorState,
  EditorSelection,
  Transaction,
  Extension,
  StateField,
  StateEffect,
  MapMode,
  CharCategory,
  Text,
  codePointAt,
  fromCodePoint,
  codePointSize,
  RangeSet,
  RangeValue,
} from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/// Configures bracket closing behavior for a syntax (via
/// [language data](#state.EditorState.languageDataAt)) using the `"closeBrackets"`
/// identifier.
interface CloseBracketConfig {
  /// The opening brackets to close. Defaults to `["(", "[", "{", "'",
  /// '"']`. Brackets may be single characters or a triple of quotes
  /// (as in `"''''"`).
  brackets?: string[];
  /// Characters in front of which newly opened brackets are
  /// automatically closed. Closing always happens in front of
  /// whitespace. Defaults to `")]}:;>"`.
  before?: string;
  /// When determining whether a given node may be a string, recognize
  /// these prefixes before the opening quote.
  stringPrefixes?: string[];
}

const defaults: Required<CloseBracketConfig> = {
  brackets: ['(', '[', '{', "'", '"'],
  before: ')]}:;>',
  stringPrefixes: [],
};

const closeBracketEffect = StateEffect.define<number>({
  map(value, mapping) {
    let mapped = mapping.mapPos(value, -1, MapMode.TrackAfter);
    return mapped == null ? undefined : mapped;
  },
});
const skipBracketEffect = StateEffect.define<number>({
  map(value, mapping) {
    return mapping.mapPos(value);
  },
});

const closedBracket = new (class extends RangeValue {})();
closedBracket.startSide = 1;
closedBracket.endSide = -1;

const bracketState = StateField.define<RangeSet<typeof closedBracket>>({
  create() {
    return RangeSet.empty;
  },
  update(value, tr) {
    if (tr.selection) {
      let lineStart = tr.state.doc.lineAt(tr.selection.main.head).from;
      let prevLineStart = tr.startState.doc.lineAt(tr.startState.selection.main.head).from;
      if (lineStart != tr.changes.mapPos(prevLineStart, -1)) {
        value = RangeSet.empty;
      }
    }
    value = value.map(tr.changes);
    for (let effect of tr.effects) {
      if (effect.is(closeBracketEffect)) {
        value = value.update({ add: [closedBracket.range(effect.value, effect.value + 1)] });
      } else if (effect.is(skipBracketEffect)) {
        value = value.update({ filter: (from) => from != effect.value });
      }
    }
    return value;
  },
});

/// Extension to enable bracket-closing behavior. When a closeable
/// bracket is typed, its closing bracket is immediately inserted
/// after the cursor. When closing a bracket directly in front of a
/// closing bracket inserted by the extension, the cursor moves over
/// that bracket.
export function closeBrackets(): Extension {
  return [inputHandler, bracketState];
}

const definedClosing = '()[]{}<>';

function closing(ch: number) {
  for (let i = 0; i < definedClosing.length; i += 2) {
    if (definedClosing.charCodeAt(i) == ch) {
      return definedClosing.charAt(i + 1);
    }
  }
  return fromCodePoint(ch < 128 ? ch : ch + 1);
}

function config(state: EditorState, pos: number) {
  return state.languageDataAt<CloseBracketConfig>('closeBrackets', pos)[0] || defaults;
}

const android = typeof navigator == 'object' && /Android\b/.test(navigator.userAgent);

const inputHandler = EditorView.inputHandler.of((view, from, to, insert) => {
  if ((android ? view.composing : view.compositionStarted) || view.state.readOnly) {
    return false;
  }
  let sel = view.state.selection.main;
  if (
    insert.length > 2 ||
    (insert.length == 2 && codePointSize(codePointAt(insert, 0)) == 1) ||
    from != sel.from ||
    to != sel.to
  ) {
    return false;
  }
  let tr = insertBracket(view.state, insert);
  if (!tr) {
    return false;
  }
  view.dispatch(tr);
  return true;
});

/// Implements the extension's behavior on text insertion. If the
/// given string counts as a bracket in the language around the
/// selection, and replacing the selection with it requires custom
/// behavior (inserting a closing version or skipping past a
/// previously-closed bracket), this function returns a transaction
/// representing that custom behavior. (You only need this if you want
/// to programmatically insert brackets—the
/// [`closeBrackets`](#autocomplete.closeBrackets) extension will
/// take care of running this for user input.)
function insertBracket(state: EditorState, bracket: string): Transaction | null {
  let conf = config(state, state.selection.main.head);
  let tokens = conf.brackets || defaults.brackets;
  for (let tok of tokens) {
    let closed = closing(codePointAt(tok, 0));
    if (bracket == tok) {
      return closed == tok
        ? handleSame(state, tok, tokens.includes(tok + tok + tok), conf)
        : handleOpen(state, tok, closed, conf.before || defaults.before);
    }
    if (bracket == closed && closedBracketAt(state, state.selection.main.from)) {
      return handleClose(state, tok, closed);
    }
  }
  return null;
}

function closedBracketAt(state: EditorState, pos: number) {
  let found = false;
  state.field(bracketState).between(0, state.doc.length, (from) => {
    if (from == pos) {
      found = true;
    }
  });
  return found;
}

function nextChar(doc: Text, pos: number) {
  let next = doc.sliceString(pos, pos + 2);
  return next.slice(0, codePointSize(codePointAt(next, 0)));
}

function handleOpen(state: EditorState, open: string, close: string, closeBefore: string) {
  let dont = null,
    changes = state.changeByRange((range) => {
      if (!range.empty) {
        return {
          changes: [
            { insert: open, from: range.from },
            { insert: close, from: range.to },
          ],
          effects: closeBracketEffect.of(range.to + open.length),
          range: EditorSelection.range(range.anchor + open.length, range.head + open.length),
        };
      }
      let next = nextChar(state.doc, range.head);
      if (!next || /\s/.test(next) || closeBefore.includes(next)) {
        return {
          changes: { insert: open + close, from: range.head },
          effects: closeBracketEffect.of(range.head + open.length),
          range: EditorSelection.cursor(range.head + open.length),
        };
      }
      return { range: (dont = range) };
    });
  return dont
    ? null
    : state.update(changes, {
        scrollIntoView: true,
        userEvent: 'input.type',
      });
}

function handleClose(state: EditorState, _open: string, close: string) {
  let dont = null,
    moved = state.selection.ranges.map((range) => {
      if (range.empty && nextChar(state.doc, range.head) == close) {
        return EditorSelection.cursor(range.head + close.length);
      }
      return (dont = range);
    });
  return dont
    ? null
    : state.update({
        selection: EditorSelection.create(moved, state.selection.mainIndex),
        scrollIntoView: true,
        effects: state.selection.ranges.map(({ from }) => skipBracketEffect.of(from)),
      });
}

// Handles cases where the open and close token are the same, and
// possibly triple quotes (as in `"""abc"""`-style quoting).
function handleSame(state: EditorState, token: string, allowTriple: boolean, config: CloseBracketConfig) {
  let stringPrefixes = config.stringPrefixes || defaults.stringPrefixes;
  let dont = null,
    changes = state.changeByRange((range) => {
      if (!range.empty) {
        return {
          changes: [
            { insert: token, from: range.from },
            { insert: token, from: range.to },
          ],
          effects: closeBracketEffect.of(range.to + token.length),
          range: EditorSelection.range(range.anchor + token.length, range.head + token.length),
        };
      }
      let pos = range.head,
        next = nextChar(state.doc, pos),
        start;
      if (next == token) {
        if (nodeStart(state, pos)) {
          return {
            changes: { insert: token + token, from: pos },
            effects: closeBracketEffect.of(pos + token.length),
            range: EditorSelection.cursor(pos + token.length),
          };
        } else if (closedBracketAt(state, pos)) {
          let isTriple = allowTriple && state.sliceDoc(pos, pos + token.length * 3) == token + token + token;
          return {
            range: EditorSelection.cursor(pos + token.length * (isTriple ? 3 : 1)),
            effects: skipBracketEffect.of(pos),
          };
        }
      } else if (
        allowTriple &&
        state.sliceDoc(pos - 2 * token.length, pos) == token + token &&
        (start = canStartStringAt(state, pos - 2 * token.length, stringPrefixes)) > -1 &&
        nodeStart(state, start)
      ) {
        return {
          changes: { insert: token + token + token + token, from: pos },
          effects: closeBracketEffect.of(pos + token.length),
          range: EditorSelection.cursor(pos + token.length),
        };
      } else if (
        state.charCategorizer(pos)(next) != CharCategory.Word &&
        canStartStringAt(state, pos, stringPrefixes) > -1 &&
        !probablyInString(state, pos, token, stringPrefixes)
      ) {
        return {
          changes: { insert: token + token, from: pos },
          effects: closeBracketEffect.of(pos + token.length),
          range: EditorSelection.cursor(pos + token.length),
        };
      }
      return { range: (dont = range) };
    });
  return dont
    ? null
    : state.update(changes, {
        scrollIntoView: true,
        userEvent: 'input.type',
      });
}

function nodeStart(state: EditorState, pos: number) {
  let tree = syntaxTree(state).resolveInner(pos + 1);
  return tree.parent && tree.from == pos;
}

function probablyInString(state: EditorState, pos: number, quoteToken: string, prefixes: readonly string[]) {
  let node = syntaxTree(state).resolveInner(pos, -1);
  let maxPrefix = prefixes.reduce((m, p) => Math.max(m, p.length), 0);
  for (let i = 0; i < 5; i++) {
    let start = state.sliceDoc(node.from, Math.min(node.to, node.from + quoteToken.length + maxPrefix));
    let quotePos = start.indexOf(quoteToken);
    if (!quotePos || (quotePos > -1 && prefixes.includes(start.slice(0, quotePos)))) {
      let first = node.firstChild;
      while (first && first.from == node.from && first.to - first.from > quoteToken.length + quotePos) {
        if (state.sliceDoc(first.to - quoteToken.length, first.to) == quoteToken) {
          return false;
        }
        first = first.firstChild;
      }
      return true;
    }
    let parent = node.to == pos && node.parent;
    if (!parent) {
      break;
    }
    node = parent;
  }
  return false;
}

function canStartStringAt(state: EditorState, pos: number, prefixes: readonly string[]) {
  let charCat = state.charCategorizer(pos);
  if (charCat(state.sliceDoc(pos - 1, pos)) != CharCategory.Word) {
    return pos;
  }
  for (let prefix of prefixes) {
    let start = pos - prefix.length;
    if (state.sliceDoc(start, pos) == prefix && charCat(state.sliceDoc(start - 1, start)) != CharCategory.Word) {
      return start;
    }
  }
  return -1;
}
