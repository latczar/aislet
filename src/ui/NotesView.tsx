import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, Divider, List, Surface, Text, useTheme } from 'react-native-paper';
import { useBackCloses } from './back';
import { PageTitle } from './PageTitle';
import { useStore } from '../store';
import type { Note } from '../types';
import { Field } from './Field';
import { confirm, formatWhen } from './confirm';
import { FONT } from './theme';

function Editor({ note, onDone }: { note: Partial<Note>; onDone: () => void }) {
  const theme = useTheme();
  const { saveNote, deleteNote } = useStore();
  const [title, setTitle] = useState(note.title ?? '');
  const [text, setText] = useState(note.text ?? '');
  const [saving, setSaving] = useState(false);
  // Back keeps what was written (as notes apps do) and closes the editor, rather than leaving the page and losing it.
  const keepAndClose = useCallback(() => {
    const changed = title !== (note.title ?? '') || text !== (note.text ?? '');
    if (changed && text.trim()) saveNote({ id: note.id, title, text }).catch(() => undefined);
    onDone();
  }, [title, text, note, saveNote, onDone]);
  useBackCloses(true, keepAndClose);

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text variant="headlineSmall" style={styles.h1}>{note.id ? 'Edit note' : 'New note'}</Text>
      <Field mode="outlined" label="Title" value={title} onChangeText={setTitle} />
      <Field
        mode="outlined"
        label="Note"
        value={text}
        onChangeText={setText}
        multiline
        style={styles.body}
        placeholder="Anything you want your assistant to know: plans, lists, how-tos…"
      />
      <View style={styles.actions}>
        {note.id && (
          <Button
            textColor={theme.colors.error}
            onPress={async () => {
              if (await confirm('Delete this note?', title)) {
                await deleteNote(note.id!);
                onDone();
              }
            }}
          >
            Delete
          </Button>
        )}
        <View style={styles.flex} />
        <Button onPress={onDone}>Cancel</Button>
        <Button
          mode="contained"
          loading={saving}
          disabled={!text.trim() || saving}
          onPress={async () => {
            setSaving(true);
            await saveNote({ id: note.id, title, text });
            setSaving(false);
            onDone();
          }}
        >
          Save
        </Button>
      </View>
    </ScrollView>
  );
}

export function NotesView({ menu }: { menu?: React.ReactNode }) {
  const theme = useTheme();
  const { notes } = useStore();
  const [editing, setEditing] = useState<Partial<Note> | null>(null);

  if (editing) return <Editor note={editing} onDone={() => setEditing(null)} />;

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.header}>
        <View style={styles.flex}>
          <PageTitle menu={menu}>Notes</PageTitle>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
            Your assistant searches these when they help answer you.
          </Text>
        </View>
        <Button mode="contained" icon="plus" onPress={() => setEditing({})}>New note</Button>
      </View>
      <Surface style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant }]} elevation={0}>
        {notes.length === 0 ? (
          <Text variant="bodyMedium" style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>
            No notes yet. Add things like routines, plans or lists you want it to know.
          </Text>
        ) : (
          notes.map((n, i) => (
            <View key={n.id}>
              {i > 0 && <Divider />}
              <List.Item
                title={n.title}
                description={`${formatWhen(n.updated)} · ${n.text.replace(/\s+/g, ' ').slice(0, 80)}`}
                descriptionNumberOfLines={1}
                left={(p) => <List.Icon {...p} icon="note-text-outline" />}
                onPress={() => setEditing(n)}
              />
            </View>
          ))
        )}
      </Surface>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 14, width: '100%', maxWidth: 760, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  h1: { fontFamily: FONT.semibold },
  card: { borderRadius: 18, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  body: { minHeight: 240 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1 },
  empty: { padding: 16 },
});
