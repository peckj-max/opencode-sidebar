/**
 * Small, dependency-free markdown renderer for assistant responses.
 * Handles: fenced code blocks, inline code, bold/italic, headings, ordered and
 * unordered lists, blockquotes, rules, pipe tables, [text](http url) links and
 * LaTeX math. Bare file paths such as `src/app.ts:42` become clickable editor
 * links.
 *
 * Math is rendered by the vendored KaTeX (media/vendor/katex.min.js, with its
 * stylesheet and fonts beside it). When KaTeX is absent the source is shown as
 * code, so nothing is ever lost.
 *
 * Everything is escaped first, so model output can never inject markup.
 * Exposed as OCMarkdown so it can be unit tested outside the webview.
 */
(function (root) {
  'use strict';

  var KNOWN_EXT =
    /\.(cs|csproj|sln|props|targets|js|mjs|cjs|jsx|ts|tsx|json|jsonc|md|txt|yml|yaml|py|html|htm|css|scss|less|sql|xml|config|sh|bash|ps1|psm1|bat|cmd|java|kt|gradle|c|cc|cpp|h|hpp|go|rs|rb|php|vue|svelte|ini|toml|env|razor|cshtml)$/i;

  /** Placeholder markers. Control characters, so no model output contains one. */
  var MARK_BLOCK = '\u0002';

  /** Rendered formulas, keyed by mode and source. See renderMath. */
  var mathCache = new Map();

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** The reverse of `esc`, for text that escapes first and renders second. */
  function unesc(s) {
    return String(s)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /**
   * Render one piece of LaTeX.
   *
   * `htmlAndMathml` is KaTeX's full output: the HTML half is what is actually
   * drawn (and the only half that can draw things MathML Core cannot, such as
   * `\boxed`), while the MathML half is there for screen readers.
   *
   * @param {string} tex
   * @param {boolean} display
   * @returns {string|null} HTML, or null when there is no usable KaTeX
   */
  function renderMath(tex, display) {
    var katex = root.katex;
    var source = String(tex == null ? '' : tex).trim();
    if (!source) return null;
    if (!katex || typeof katex.renderToString !== 'function') return null;

    var key = (display ? 'D' : 'I') + source;
    if (mathCache.has(key)) return mathCache.get(key);

    var html;
    try {
      html = katex.renderToString(source, {
        displayMode: !!display,
        output: 'htmlAndMathml',
        // A command KaTeX does not know should leave a readable result, not
        // take the whole message down.
        throwOnError: false,
        strict: 'ignore'
      });
    } catch (e) {
      return null;
    }
    // A streaming answer re-renders on every frame; only the formula that is
    // still arriving is new, so the rest must not be typeset again. Bounded so
    // a very long session cannot grow this without limit.
    if (mathCache.size < 400) mathCache.set(key, html);
    return html;
  }

  /**
   * A block of math, or — when it cannot be rendered — its source in a code
   * block, so the reader still sees what the model wrote.
   */
  function blockMath(tex) {
    var html = renderMath(cleanMathSource(tex), true);
    if (html) return '<div class="math-block">' + html + '</div>';
    return '<pre class="math-src"><code>' + esc(cleanMathSource(tex)) + '</code></pre>';
  }

  function inlineMath(tex) {
    var html = renderMath(String(tex == null ? '' : tex).trim(), false);
    if (html) return '<span class="math-inline">' + html + '</span>';
    return '<code class="math-src">' + esc(String(tex == null ? '' : tex).trim()) + '</code>';
  }

  /**
   * Strip the blockquote prefix from display math written inside a quote, and
   * the blank lines a model often leaves inside `\[ … \]`.
   */
  function cleanMathSource(tex) {
    return String(tex == null ? '' : tex)
      .split(/\r?\n/)
      .map(function (line) {
        return line.replace(/^\s*>\s?/, '');
      })
      .join('\n')
      .replace(/^\s+|\s+$/g, '');
  }

  /**
   * Make file references clickable. Recognises a bare path, a single line
   * (`src/app.cs:42`), a range (`src/app.cs:42-50`) and a column
   * (`src/app.cs:42:7`). Expects already-escaped text, and requires either a
   * path separator or a known extension so model names stay plain text.
   */
  function anchor(path, line, col, endLine, shown) {
    return (
      '<a href="#" data-path="' +
      path +
      '"' +
      (line ? ' data-line="' + line + '"' : '') +
      (col ? ' data-col="' + col + '"' : '') +
      (endLine ? ' data-end-line="' + endLine + '"' : '') +
      '>' +
      (shown || path) +
      '</a>'
    );
  }

  function looksLikePath(p) {
    return /[\\/]/.test(p) || KNOWN_EXT.test(p);
  }

  /**
   * Linkify the contents of an inline code span. Because the whole span is
   * usually the path verbatim, spaces are allowed here — that is what makes
   * `Database Changes/file.txt` work. Spans holding prose fall back to the
   * stricter scanning used for normal text.
   */
  function linkifyCodeSpan(c) {
    var m = c.match(
      /^(\s*)((?:[A-Za-z]:[\\/]|\/)?[A-Za-z0-9_][A-Za-z0-9_ ./\\()-]*\.[A-Za-z0-9_]{1,8})(?::(\d+)(?::(\d+))?(?:[-–](\d+))?)?(\s*)$/
    );
    if (m && looksLikePath(m[2])) {
      // Keep the line / range in the visible text, as the plain-text path
      // linkifier does; otherwise the reader loses "which line".
      var shown = m[2];
      if (m[3]) shown += ':' + m[3] + (m[5] ? '-' + m[5] : '');
      return m[1] + anchor(m[2], m[3], m[4], m[5], shown) + m[6];
    }
    return linkifyPaths(c);
  }

  function linkifyPaths(html) {
    return html.replace(
      /(^|[\s("'])((?:[A-Za-z]:[\\/]|\/)?[A-Za-z0-9_][A-Za-z0-9_./\\-]*\.[A-Za-z0-9_]{1,8})(?::(\d+)(?::(\d+))?(?:[-–](\d+))?)?/g,
      function (m, pre, path, line, col, endLine) {
        if (!/[\\/]/.test(path) && !KNOWN_EXT.test(path)) return m;
        var shown = path;
        if (line) shown += ':' + line + (endLine ? '-' + endLine : '');
        return pre + anchor(path, line, col, endLine, shown);
      }
    );
  }

  function inline(s) {
    var stash = [];
    function keep(html) {
      stash.push(html);
      return '\u0001' + (stash.length - 1) + '\u0001';
    }

    var out = esc(s);
    out = out.replace(/`([^`]+)`/g, function (m, c) {
      // File paths are nearly always written in backticks, so linkify inside
      // the code span too — otherwise the most common mention is not clickable.
      return keep('<code>' + linkifyCodeSpan(c) + '</code>');
    });
    out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, function (m, t, u) {
      return keep('<a href="#" data-url="' + u + '">' + t + '</a>');
    });
    // Math, once code spans and links are tucked away: `\(x\)` inside a code
    // span must stay literal, and the TeX itself must never meet the emphasis
    // rules below — `a*b*c` and `x_1` mean something else there.
    out = out.replace(/\\\(([\s\S]+?)\\\)/g, function (m, tex) {
      return keep(inlineMath(unesc(tex)));
    });
    // `$…$`, with guards so a price is not typeset: the content may not touch
    // either `$`, and a closing `$` followed by a digit is money, not math.
    out = out.replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*[^\s$])?)\$(?![\d])/g, function (m, pre, tex) {
      return pre + keep(inlineMath(unesc(tex)));
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = linkifyPaths(out);
    return out.replace(/\u0001(\d+)\u0001/g, function (m, i) {
      return stash[Number(i)];
    });
  }

  /**
   * Split a table row on its pipes.
   *
   * The outer pipes are optional in GitHub's tables, and `\|` is a literal
   * pipe, so neither may be treated as a cell boundary.
   */
  function splitCells(line) {
    var body = String(line == null ? '' : line).trim();
    if (body.charAt(0) === '|') body = body.slice(1);
    if (body.charAt(body.length - 1) === '|') body = body.slice(0, -1);
    var cells = [];
    var current = '';
    for (var i = 0; i < body.length; i++) {
      var ch = body.charAt(i);
      if (ch === '\\' && body.charAt(i + 1) === '|') {
        current += '|';
        i++;
        continue;
      }
      if (ch === '|') {
        cells.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    cells.push(current.trim());
    return cells;
  }

  /** The `| --- | :--: |` row that turns the line above it into a header. */
  function isDivider(line) {
    var text = String(line == null ? '' : line).trim();
    if (text.indexOf('-') < 0) return false;
    var cells = splitCells(text);
    if (!cells.length) return false;
    for (var i = 0; i < cells.length; i++) {
      if (!/^:?-+:?$/.test(cells[i])) return false;
    }
    return true;
  }

  /** Column alignment, as the class the stylesheet expects. */
  function alignClass(cell) {
    var left = cell.charAt(0) === ':';
    var right = cell.charAt(cell.length - 1) === ':';
    if (left && right) return ' ta-c';
    if (right) return ' ta-r';
    if (left) return ' ta-l';
    return '';
  }

  function isRowLine(line) {
    return String(line == null ? '' : line).indexOf('|') >= 0;
  }

  /**
   * Read a table starting at `start`, or null when the lines are not one.
   *
   * Blank lines between rows are tolerated: models routinely separate rows
   * that way, and rejecting those leaves the pipes showing as prose. A blank
   * line only ends the table when no row follows it.
   *
   * @returns {{html:string, next:number}|null}
   */
  function readTable(lines, start) {
    var headerLine = String(lines[start] == null ? '' : lines[start]).trim();
    if (!isRowLine(headerLine)) return null;
    var header = splitCells(headerLine);
    if (header.length < 2) return null;

    var dividerAt = start + 1;
    while (dividerAt < lines.length && !String(lines[dividerAt]).trim()) dividerAt++;
    if (dividerAt >= lines.length || !isDivider(lines[dividerAt])) return null;
    var divider = splitCells(lines[dividerAt]);
    // GitHub requires the delimiter row to match the header, and insisting on
    // it keeps a stray `a | b` above a horizontal rule from becoming a table.
    if (divider.length !== header.length) return null;

    var rows = [];
    var at = dividerAt + 1;
    while (at < lines.length) {
      var text = String(lines[at]).trim();
      if (!text) {
        var peek = at + 1;
        while (peek < lines.length && !String(lines[peek]).trim()) peek++;
        if (peek < lines.length && isRowLine(lines[peek])) {
          at = peek;
          continue;
        }
        break;
      }
      if (!isRowLine(text)) break;
      rows.push(splitCells(text));
      at++;
    }

    var cols = header.length;
    var html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
    for (var h = 0; h < cols; h++) {
      html += '<th class="ta-th' + alignClass(divider[h]) + '">' + inline(header[h]) + '</th>';
    }
    html += '</tr></thead>';
    if (rows.length) {
      html += '<tbody>';
      for (var r = 0; r < rows.length; r++) {
        html += '<tr>';
        // Extra cells are dropped and missing ones left empty, so a model that
        // miscounts a row cannot break the table's shape.
        for (var c = 0; c < cols; c++) {
          html += '<td class="ta-td' + alignClass(divider[c]) + '">' + inline(rows[r][c] || '') + '</td>';
        }
        html += '</tr>';
      }
      html += '</tbody>';
    }
    html += '</table></div>';
    return { html: html, next: at };
  }

  function renderMarkdown(src) {
    var fences = [];
    var text = String(src == null ? '' : src);

    // Pull fenced blocks out first so their contents are never inline-processed.
    text = text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, function (m, code) {
      fences.push('<pre class="code"><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>');
      return '\u0000' + (fences.length - 1) + '\u0000';
    });

    // Display math next, for the same reason and one more: the TeX may span
    // lines and contain `|` or `*`, which the block rules below would read as a
    // table or as emphasis.
    var blocks = [];
    function holdMath(tex) {
      blocks.push(blockMath(tex));
      return MARK_BLOCK + (blocks.length - 1) + MARK_BLOCK;
    }
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, function (m, tex) {
      return holdMath(tex);
    });
    text = text.replace(/\\\[([\s\S]+?)\\\]/g, function (m, tex) {
      return holdMath(tex);
    });
    // An answer still streaming: the opening delimiter has arrived but not the
    // closing one, so the derivation would otherwise show as raw LaTeX until
    // it finishes. The tail is typeset as a block and replaced when it closes.
    var open = text.lastIndexOf('\\[');
    if (open >= 0 && text.indexOf('\\]', open) < 0) {
      text = text.slice(0, open) + holdMath(text.slice(open + 2));
    }

    var html = '';
    var list = null;
    function closeList() {
      if (list) {
        html += '</' + list + '>';
        list = null;
      }
    }

    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var fence = raw.match(/^\u0000(\d+)\u0000$/);
      if (fence) {
        closeList();
        html += fences[Number(fence[1])];
        continue;
      }

      var line = raw.trim();
      if (!line) {
        closeList();
        continue;
      }

      // A display formula alone on its line is its own block.
      var mathLine = line.match(/^\u0002(\d+)\u0002$/);
      if (mathLine) {
        closeList();
        html += blocks[Number(mathLine[1])];
        continue;
      }

      var m;
      // A table is recognised before the heading and list rules, since a cell
      // may itself start with `-` or `#`.
      var table = readTable(lines, i);
      if (table) {
        closeList();
        html += table.html;
        i = table.next - 1;
        continue;
      }
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        closeList();
        var lvl = m[1].length;
        html += '<h' + lvl + '>' + inline(m[2]) + '</h' + lvl + '>';
      } else if (/^(-{3,}|\*{3,})$/.test(line)) {
        closeList();
        html += '<hr>';
      } else if ((m = line.match(/^>\s?(.*)$/))) {
        closeList();
        html += '<blockquote>' + inline(m[1]) + '</blockquote>';
      } else if ((m = line.match(/^[-*+]\s+(.*)$/))) {
        if (list !== 'ul') {
          closeList();
          html += '<ul>';
          list = 'ul';
        }
        html += '<li>' + inline(m[1]) + '</li>';
      } else if ((m = line.match(/^\d+[.)]\s+(.*)$/))) {
        if (list !== 'ol') {
          closeList();
          html += '<ol>';
          list = 'ol';
        }
        html += '<li>' + inline(m[1]) + '</li>';
      } else {
        closeList();
        html += '<p>' + inline(line) + '</p>';
      }
    }
    closeList();
    // Anything left: display math quoted with `>`, or sitting inside a line of
    // prose. Expanded last, so it lands wherever the placeholder ended up.
    html = html.replace(/\u0002(\d+)\u0002/g, function (m, i) {
      return blocks[Number(i)] || '';
    });
    return html;
  }

  root.OCMarkdown = {
    renderMarkdown: renderMarkdown,
    inline: inline,
    linkifyPaths: linkifyPaths,
    renderMath: renderMath,
    esc: esc
  };
})(typeof window !== 'undefined' ? window : globalThis);
