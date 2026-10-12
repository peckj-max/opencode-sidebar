/**
 * Small, dependency-free markdown renderer for assistant responses.
 * Handles: fenced code blocks, inline code, bold/italic, headings, ordered and
 * unordered lists, blockquotes, rules, and [text](http url) links. Bare file
 * paths such as `src/app.ts:42` become clickable editor links.
 *
 * Everything is escaped first, so model output can never inject markup.
 * Exposed as OCMarkdown so it can be unit tested outside the webview.
 */
(function (root) {
  'use strict';

  var KNOWN_EXT =
    /\.(cs|csproj|sln|props|targets|js|mjs|cjs|jsx|ts|tsx|json|jsonc|md|txt|yml|yaml|py|html|htm|css|scss|less|sql|xml|config|sh|bash|ps1|psm1|bat|cmd|java|kt|gradle|c|cc|cpp|h|hpp|go|rs|rb|php|vue|svelte|ini|toml|env|razor|cshtml)$/i;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = linkifyPaths(out);
    return out.replace(/\u0001(\d+)\u0001/g, function (m, i) {
      return stash[Number(i)];
    });
  }

  function renderMarkdown(src) {
    var fences = [];
    var text = String(src == null ? '' : src);

    // Pull fenced blocks out first so their contents are never inline-processed.
    text = text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, function (m, code) {
      fences.push('<pre class="code"><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>');
      return '\u0000' + (fences.length - 1) + '\u0000';
    });

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

      var m;
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
    return html;
  }

  root.OCMarkdown = { renderMarkdown: renderMarkdown, inline: inline, linkifyPaths: linkifyPaths, esc: esc };
})(typeof window !== 'undefined' ? window : globalThis);
