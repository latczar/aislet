// Small Markdown renderer for replies: paragraphs, headings, lists, code, bold and italics.
import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Text, useTheme } from 'react-native-paper';
import { FONT } from './theme';

const LIST = /^\s*([-*•]|\d+[.)])\s+/;
const MONO = Platform.select({ web: 'ui-monospace, Consolas, monospace', android: 'monospace', default: 'Menlo' });

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] };

function parse(src: string): Block[] {
  const lines = src.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) code.push(lines[i++]);
      i++;
      blocks.push({ kind: 'code', text: code.join('\n') });
    } else if (LIST.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && LIST.test(lines[i])) items.push(lines[i++].replace(LIST, ''));
      blocks.push({ kind: 'list', ordered, items });
    } else if (/^#{1,6}\s/.test(line)) {
      blocks.push({ kind: 'h', text: line.replace(/^#+\s/, '') });
      i++;
    } else if (!line.trim()) {
      i++;
    } else {
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() && !lines[i].trimStart().startsWith('```') && !LIST.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])) {
        para.push(lines[i++]);
      }
      blocks.push({ kind: 'p', text: para.join('\n') });
    }
  }
  return blocks;
}

function Inline({ text, codeBg }: { text: string; codeBg: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) return <Text key={i} style={styles.bold}>{part.slice(2, -2)}</Text>;
        if (part.startsWith('`') && part.endsWith('`')) {
          return <Text key={i} style={[styles.inlineCode, { backgroundColor: codeBg }]}>{part.slice(1, -1)}</Text>;
        }
        if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) return <Text key={i} style={styles.italic}>{part.slice(1, -1)}</Text>;
        return part;
      })}
    </>
  );
}

export function Markdown({ text }: { text: string }) {
  const theme = useTheme();
  const codeBg = theme.colors.surfaceVariant;
  return (
    <View style={styles.wrap}>
      {parse(text).map((b, i) => {
        switch (b.kind) {
          case 'h':
            return <Text key={i} variant="titleMedium" style={styles.heading} selectable><Inline text={b.text} codeBg={codeBg} /></Text>;
          case 'code':
            return (
              <View key={i} style={[styles.codeBlock, { backgroundColor: codeBg, borderColor: theme.colors.outlineVariant }]}>
                <Text style={styles.code} selectable>{b.text}</Text>
              </View>
            );
          case 'list':
            return (
              <View key={i} style={styles.list}>
                {b.items.map((item, j) => (
                  <View key={j} style={styles.item}>
                    <Text variant="bodyLarge" style={styles.marker}>{b.ordered ? `${j + 1}.` : '•'}</Text>
                    <Text variant="bodyLarge" style={styles.itemText} selectable><Inline text={item} codeBg={codeBg} /></Text>
                  </View>
                ))}
              </View>
            );
          default:
            return <Text key={i} variant="bodyLarge" style={styles.para} selectable><Inline text={b.text} codeBg={codeBg} /></Text>;
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
  inlineCode: { fontFamily: MONO, fontSize: 14, borderRadius: 4, paddingHorizontal: 4 },
  codeBlock: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, padding: 12 },
  code: { fontFamily: MONO, fontSize: 13, lineHeight: 19 },
  list: { gap: 6 },
  item: { flexDirection: 'row', gap: 8 },
  marker: { minWidth: 18, lineHeight: 24 },
  itemText: { flex: 1, lineHeight: 24 },
});
