// Small Markdown renderer for replies: paragraphs, headings, lists, tables, code, links, bold and italics.
import React, { useState } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { IconButton, Text, useTheme } from 'react-native-paper';
import { copy } from './actions';
import { confirm } from './confirm';
import { FONT } from './theme';

const LIST = /^(\s*)([-*•+]|\d+[.)])\s+/;
const HEADING = /^#{1,6}\s/;
const FENCE = /^\s*```/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const MONO = Platform.select({ web: 'ui-monospace, Consolas, monospace', android: 'monospace', default: 'Menlo' });

type Align = 'left' | 'center' | 'right';
type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string; level: number }
  | { kind: 'code'; text: string; lang: string }
  | { kind: 'list'; items: { text: string; marker: string; indent: number }[] }
  | { kind: 'table'; head: string[]; align: Align[]; rows: string[][] };

/** Split a table row into cells: "| a | b |" -> ["a", "b"]. A pipe written as \| stays in the cell. */
function cells(line: string): string[] {
  const out: string[] = [''];
  const s = line.trim();
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') out[out.length - 1] += s[++i];
    else if (s[i] === '|') out.push('');
    else out[out.length - 1] += s[i];
  }
  if (s.startsWith('|')) out.shift();
  if (s.endsWith('|') && !s.endsWith('\\|')) out.pop();
  return out.map((c) => c.trim());
}

function isTableStart(lines: string[], i: number): boolean {
  return lines[i].includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-');
}

function startsBlock(lines: string[], i: number): boolean {
  return FENCE.test(lines[i]) || LIST.test(lines[i]) || HEADING.test(lines[i]) || isTableStart(lines, i);
}

function parse(src: string): Block[] {
  const lines = src.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE.test(line)) {
      const lang = line.trim().slice(3).trim().split(/\s/)[0] ?? '';
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push({ kind: 'code', text: code.join('\n'), lang });
    } else if (isTableStart(lines, i)) {
      const head = cells(line);
      const align: Align[] = cells(lines[i + 1]).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : 'left'));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      const width = head.length;
      blocks.push({ kind: 'table', head, align, rows: rows.map((r) => Array.from({ length: width }, (_, c) => r[c] ?? '')) });
    } else if (LIST.test(line)) {
      const items: { text: string; marker: string; indent: number }[] = [];
      while (i < lines.length && LIST.test(lines[i])) {
        const [, spaces, mark] = lines[i].match(LIST)!;
        const ordered = /\d/.test(mark);
        items.push({ text: lines[i].replace(LIST, ''), marker: ordered ? `${parseInt(mark, 10)}.` : '•', indent: Math.min(3, Math.floor(spaces.length / 2)) });
        i++;
      }
      blocks.push({ kind: 'list', items });
    } else if (HEADING.test(line)) {
      blocks.push({ kind: 'h', text: line.replace(/^#+\s/, ''), level: line.indexOf(' ') });
      i++;
    } else if (!line.trim()) {
      i++;
    } else {
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines, i))) para.push(lines[i++]);
      blocks.push({ kind: 'p', text: para.join('\n') });
    }
  }
  return blocks;
}

// ---- Links: open in the browser only after the user says yes ----

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

async function openLink(url: string) {
  if (!SAFE_LINK.test(url)) return;
  const shown = url.length > 120 ? `${url.slice(0, 117)}…` : url;
  if (await confirm('Open this link?', `It opens in your browser.\n\n${shown}`, 'Open')) {
    Linking.openURL(url).catch(() => undefined);
  }
}

// Inline pieces, in order of priority: code, [links](url), bold, bare web addresses, italics.
const INLINE = /(`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*\n]+\*\*|https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"*]|\*[^*\n]+\*)/g;

function Inline({ text, codeBg, link }: { text: string; codeBg: string; link: string }) {
  const parts = text.split(INLINE).filter(Boolean);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return <Text key={i} style={[styles.inlineCode, { backgroundColor: codeBg }]}>{part.slice(1, -1)}</Text>;
        }
        const md = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
        const url = md ? md[2] : /^https?:\/\//.test(part) ? part : null;
        if (url && SAFE_LINK.test(url)) {
          return (
            <Text key={i} style={[styles.link, { color: link }]} onPress={() => openLink(url)} accessibilityRole="link">
              {md ? md[1] : part}
            </Text>
          );
        }
        if (md) return md[1]; // not a web link: show just the words
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <Text key={i} style={styles.bold}>{part.slice(2, -2)}</Text>;
        if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) return <Text key={i} style={styles.italic}>{part.slice(1, -1)}</Text>;
        return part;
      })}
    </>
  );
}

function CodeBlock({ text, lang }: { text: string; lang: string }) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  return (
    <View style={[styles.codeBlock, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]}>
      <View style={[styles.codeBar, { borderBottomColor: theme.colors.outlineVariant }]}>
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>{lang || 'code'}</Text>
        <IconButton
          icon={copied ? 'check' : 'content-copy'} size={15} style={styles.codeCopy} iconColor={theme.colors.onSurfaceVariant}
          accessibilityLabel={copied ? 'Copied' : 'Copy code'}
          onPress={async () => { await copy(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeScroll}>
        <Text style={[styles.code, { color: theme.colors.onSurface }]} selectable>{text}</Text>
      </ScrollView>
    </View>
  );
}

/** Column widths from the longest text in each column, so rows line up without measuring. */
function columnWidths(head: string[], rows: string[][]): number[] {
  return head.map((h, c) => {
    const longest = Math.max(h.length, ...rows.map((r) => (r[c] ?? '').replace(/[*`]/g, '').length));
    return Math.min(260, Math.max(72, longest * 8 + 24));
  });
}

function Table({ head, align, rows, codeBg, link }: { head: string[]; align: Align[]; rows: string[][]; codeBg: string; link: string }) {
  const theme = useTheme();
  const widths = columnWidths(head, rows);
  const border = { borderColor: theme.colors.outlineVariant };
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={[styles.table, border]}>
        {[head, ...rows].map((row, r) => (
          <View
            key={r}
            style={[styles.tr, r > 0 && styles.trBorder, border, r === 0 && { backgroundColor: theme.colors.surfaceVariant }]}
          >
            {row.map((cell, c) => (
              <Text
                key={c}
                variant="bodyMedium"
                selectable
                style={[styles.td, { width: widths[c], textAlign: align[c] ?? 'left' }, c > 0 && styles.tdBorder, border, r === 0 && styles.bold]}
              >
                <Inline text={cell} codeBg={codeBg} link={link} />
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

export function Markdown({ text }: { text: string }) {
  const theme = useTheme();
  const codeBg = theme.colors.surfaceVariant;
  const link = theme.colors.primary;
  return (
    <View style={styles.wrap}>
      {parse(text).map((b, i) => {
        switch (b.kind) {
          case 'h':
            return (
              <Text key={i} variant={b.level <= 2 ? 'titleLarge' : 'titleMedium'} style={styles.heading} selectable>
                <Inline text={b.text} codeBg={codeBg} link={link} />
              </Text>
            );
          case 'code':
            return <CodeBlock key={i} text={b.text} lang={b.lang} />;
          case 'table':
            return <Table key={i} head={b.head} align={b.align} rows={b.rows} codeBg={codeBg} link={link} />;
          case 'list':
            return (
              <View key={i} style={styles.list}>
                {b.items.map((item, j) => (
                  <View key={j} style={[styles.item, { marginLeft: item.indent * 18 }]}>
                    <Text variant="bodyLarge" style={styles.marker}>{item.marker}</Text>
                    <Text variant="bodyLarge" style={styles.itemText} selectable><Inline text={item.text} codeBg={codeBg} link={link} /></Text>
                  </View>
                ))}
              </View>
            );
          default:
            return <Text key={i} variant="bodyLarge" style={styles.para} selectable><Inline text={b.text} codeBg={codeBg} link={link} /></Text>;
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  para: { lineHeight: 24 },
  heading: { fontFamily: FONT.semibold, marginTop: 4 },
  bold: { fontFamily: FONT.semibold },
  italic: { fontStyle: 'italic' },
  link: { textDecorationLine: 'underline' },
  inlineCode: { fontFamily: MONO, fontSize: 14, borderRadius: 4, paddingHorizontal: 4 },
  codeBlock: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  codeBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  codeCopy: { margin: 0 },
  codeScroll: { padding: 12 },
  code: { fontFamily: MONO, fontSize: 13, lineHeight: 19 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: 'hidden' },
  tr: { flexDirection: 'row' },
  trBorder: { borderTopWidth: StyleSheet.hairlineWidth },
  td: { paddingHorizontal: 10, paddingVertical: 7, lineHeight: 20 },
  tdBorder: { borderLeftWidth: StyleSheet.hairlineWidth },
  list: { gap: 6 },
  item: { flexDirection: 'row', gap: 8 },
  marker: { minWidth: 18, lineHeight: 24 },
  itemText: { flex: 1, lineHeight: 24 },
});
