import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator, Button, Checkbox, Dialog, Divider, Icon, IconButton, List, Portal, Searchbar, Snackbar, Surface, Switch, Text, useTheme,
} from 'react-native-paper';
import { PageTitle } from './PageTitle';
import { CATEGORIES, type TidyChange } from '../brain';
import { type TidyUndo, useStore } from '../store';
import type { Memory } from '../types';
import { Field } from './Field';
import { confirm } from './confirm';
import { Row } from './rows';
import { FONT } from './theme';

/** Facts a section shows before "Show all": the newest ones. */
const SHOWN = 5;
/** Beyond this many current facts, a search box helps find one. */
const SEARCH_FROM = 20;

/** One suggested change: what goes, what replaces it and why. */
function TidyItem({ change, memories, checked, onToggle }: { change: TidyChange; memories: Memory[]; checked: boolean; onToggle: () => void }) {
  const theme = useTheme();
  const removed = memories.filter((m) => change.remove.includes(m.id));
  const kept = memories.find((m) => m.id === change.keep);
  const kind = { duplicate: 'Duplicate', contradiction: 'Out of date', overlap: 'Merge' }[change.kind];
  return (
    <View style={styles.tidyItem}>
      <Checkbox.Android status={checked ? 'checked' : 'unchecked'} onPress={onToggle} accessibilityLabel={`${kind}: apply this change`} />
      <View style={styles.flex}>
        <Text variant="labelLarge" style={{ color: theme.colors.primary }} onPress={onToggle}>{kind}</Text>
        {removed.map((m) => (
          <Text key={m.id} variant="bodyMedium" style={[styles.struck, { color: theme.colors.onSurfaceVariant }]}>{m.fact}</Text>
        ))}
        {change.add && <Text variant="bodyMedium" style={{ fontFamily: FONT.medium }}>→ {change.add.fact}</Text>}
        {kept && <Text variant="bodyMedium">Keeps: {kept.fact}</Text>}
        {!!change.reason && <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>{change.reason}</Text>}
      </View>
    </View>
  );
}

export function MemoryView({ onStartInterview, inBar }: { onStartInterview: () => void; inBar?: boolean }) {
  const theme = useTheme();
  const {
    memories, addMemory, removeMemory, proposeTidy, proposeCompress, applyTidy, undoTidy, settings, updateSettings, startInterview,
    status, busy,
  } = useStore();
  const [fact, setFact] = useState('');
  // Which suggestions are being looked for, or shown: Tidy up's or Compress's. They share the dialog.
  const [working, setWorking] = useState<'tidy' | 'compress' | null>(null);
  const [mode, setMode] = useState<'tidy' | 'compress'>('tidy');
  const [changes, setChanges] = useState<TidyChange[] | null>(null);
  const [picked, setPicked] = useState<boolean[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [undo, setUndo] = useState<TidyUndo | null>(null);
  // Sections folded away (what's no longer true starts folded), and sections showing all their facts.
  const [folded, setFolded] = useState<Set<string>>(() => new Set(['earlier']));
  const [showAll, setShowAll] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const matches = (m: Memory) => terms.every((t) => m.fact.toLowerCase().includes(t));
  const flip = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };
  const current = memories.filter((m) => !m.until).length;
  const card = [styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant }];
  const chosen = changes?.filter((_, i) => picked[i]) ?? [];

  const add = async () => {
    if (await addMemory(fact)) setFact('');
  };

  const show = (message: string, canUndo: TidyUndo | null = null) => {
    setUndo(canUndo);
    setToast(message);
  };

  const suggest = async (kind: 'tidy' | 'compress') => {
    setWorking(kind);
    setUndo(null);
    try {
      const found = await (kind === 'tidy' ? proposeTidy() : proposeCompress());
      if (!found.length) {
        show(kind === 'tidy' ? 'All tidy: no duplicates or out-of-date facts found.' : 'Nothing to merge: no related facts found.');
      } else {
        setMode(kind);
        setPicked(found.map(() => true));
        setChanges(found);
      }
    } catch (e) {
      show((e as Error).message || "Couldn't check your memory just now.");
    } finally {
      setWorking(null);
    }
  };

  const apply = async () => {
    const n = chosen.length;
    const merged = chosen.reduce((sum, c) => sum + c.remove.length, 0);
    const done = await applyTidy(chosen);
    setChanges(null);
    show(mode === 'compress'
      ? `Merged ${merged} facts into ${n}.`
      : `Tidied: ${n} ${n === 1 ? 'change' : 'changes'} made.`, done);
  };

  const putBack = async (done: TidyUndo) => {
    try {
      await undoTidy(done);
      show('Put back as it was.');
    } catch {
      show("Couldn't undo. Try again.");
    }
  };

  return (
    <View style={styles.flex}>
    <ScrollView contentContainerStyle={styles.page}>
      <PageTitle inBar={inBar}>Memory</PageTitle>
      <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
        What it knows about you, learnt from your chats and feedback like "shorter, please". Undo anything it learns, or
        remove it here. {settings.learn ? '' : 'Learning is off (Settings → More settings → Memory).'}
      </Text>

      <Surface style={card} elevation={0}>
        <Row
          title="Get to know me"
          description="A short chat where it asks about you, one question at a time"
          left={(p) => <List.Icon {...p} icon="account-heart-outline" color={theme.colors.primary} />}
          right={(p) => (
            <Button
              mode="contained-tonal"
              compact
              style={p.style}
              disabled={!status?.ready || busy}
              onPress={() => { onStartInterview(); startInterview(); }}
            >
              Start
            </Button>
          )}
        />
        <Divider />
        <Row
          title="Tidy up memory"
          description={working === 'tidy' ? 'Looking for duplicates and out-of-date facts…' : 'Finds duplicates and out-of-date facts. You approve each change.'}
          left={(p) => <List.Icon {...p} icon="broom" color={theme.colors.primary} />}
          right={(p) => (working === 'tidy'
            ? <ActivityIndicator size={18} style={[p.style, styles.tidySpinner]} accessibilityLabel="Tidying" />
            : (
              <Button mode="contained-tonal" compact style={p.style} disabled={!status?.ready || busy || current < 2} onPress={() => suggest('tidy')}>
                Tidy up
              </Button>
            ))}
        />
        <Divider />
        <Row
          title="Compress memory"
          description={working === 'compress' ? 'Looking for related facts to merge…' : 'Merges related facts into fewer, shorter ones. You approve each merge.'}
          left={(p) => <List.Icon {...p} icon="call-merge" color={theme.colors.primary} />}
          right={(p) => (working === 'compress'
            ? <ActivityIndicator size={18} style={[p.style, styles.tidySpinner]} accessibilityLabel="Compressing" />
            : (
              <Button mode="contained-tonal" compact style={p.style} disabled={!status?.ready || busy || current < 2} onPress={() => suggest('compress')}>
                Compress
              </Button>
            ))}
        />
        <Divider />
        <View style={styles.addRow}>
          <Field
            mode="outlined"
            dense
            style={styles.flex}
            placeholder="Add a fact about you"
            value={fact}
            onChangeText={setFact}
            onSubmitEditing={add}
          />
          <Button mode="contained-tonal" compact onPress={add} disabled={!fact.trim()}>Add</Button>
        </View>
      </Surface>

      {(current > SEARCH_FROM || searching) && (
        <Searchbar
          placeholder="Search your facts"
          value={query}
          onChangeText={setQuery}
          elevation={0}
          style={[styles.search, { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant }]}
        />
      )}
      {searching && !memories.some(matches) && (
        <Text variant="bodyMedium" style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>No facts match "{query.trim()}".</Text>
      )}

      {memories.length === 0 ? (
        <Text variant="bodyMedium" style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>
          Nothing yet. Start "Get to know me", tell it about yourself in any chat, or add a fact above.
        </Text>
      ) : (
        [
          ...CATEGORIES.map((c) => ({ ...c, group: memories.filter((m) => !m.until && (m.category ?? 'about') === c.id) })),
          // Facts a newer one replaced (an old job, an old address): kept so questions about the past can use them.
          { id: 'earlier', title: 'No longer true', icon: 'history', group: memories.filter((m) => m.until) },
        ].map(({ id, title, icon, group: all }) => {
          const group = searching ? all.filter(matches) : all; // a search shows every match, unfolded
          if (!group.length) return null;
          const isFolded = !searching && folded.has(id);
          const newest = [...group].reverse(); // newest first, so what it just learnt is never hidden
          const long = !searching && newest.length > SHOWN + 1; // hiding a single fact behind a button isn't worth it
          const shown = long && !showAll.has(id) ? newest.slice(0, SHOWN) : newest;
          return (
            <View key={id} style={styles.group}>
              <Pressable
                style={styles.groupHead}
                onPress={() => setFolded((f) => flip(f, id))}
                accessibilityRole="button"
                accessibilityState={{ expanded: !isFolded }}
                accessibilityLabel={`${title}, ${group.length} ${group.length === 1 ? 'fact' : 'facts'}`}
              >
                <Icon source={icon} size={18} color={theme.colors.onSurfaceVariant} />
                <Text variant="labelLarge" style={{ color: theme.colors.onSurfaceVariant }}>{title} · {group.length}</Text>
                <Icon source={isFolded ? 'chevron-right' : 'chevron-down'} size={18} color={theme.colors.onSurfaceVariant} />
              </Pressable>
              {!isFolded && (
                <Surface style={card} elevation={0}>
                  {shown.map((m, i) => (
                    <View key={m.id}>
                      {i > 0 && <Divider />}
                      <List.Item
                        title={m.fact}
                        titleNumberOfLines={4}
                        description={m.until ? `${m.added} to ${m.until}` : m.added}
                        right={(p) => (
                          <IconButton
                            icon="close"
                            size={18}
                            style={[styles.iconAction, p.style]}
                            accessibilityLabel="Forget this"
                            onPress={async () => {
                              if (await confirm('Forget this?', m.fact, 'Forget')) removeMemory(m.id);
                            }}
                          />
                        )}
                      />
                    </View>
                  ))}
                  {long && (
                    <>
                      <Divider />
                      <List.Item
                        title={showAll.has(id) ? 'Show fewer' : `Show all ${group.length}`}
                        titleStyle={{ color: theme.colors.primary, fontFamily: FONT.medium }}
                        onPress={() => setShowAll((a) => flip(a, id))}
                        right={(p) => <List.Icon {...p} icon={showAll.has(id) ? 'chevron-up' : 'chevron-down'} color={theme.colors.primary} />}
                      />
                    </>
                  )}
                </Surface>
              )}
            </View>
          );
        })
      )}
    </ScrollView>

      <Portal>
        <Dialog visible={!!changes} onDismiss={() => setChanges(null)} style={styles.dialog}>
          <Dialog.Title style={{ fontFamily: FONT.semibold }}>{mode === 'compress' ? 'Suggested merges' : 'Suggested changes'}</Dialog.Title>
          <Dialog.ScrollArea style={styles.dialogScroll}>
            <ScrollView contentContainerStyle={styles.tidyList}>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Untick anything you want to keep as it is. Nothing changes until you apply.
              </Text>
              {changes?.map((c, i) => (
                <TidyItem
                  key={i} change={c} memories={memories} checked={!!picked[i]}
                  onToggle={() => setPicked((p) => p.map((v, j) => (j === i ? !v : v)))}
                />
              ))}
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={() => setChanges(null)}>Cancel</Button>
            <Button mode="contained" disabled={!chosen.length} onPress={apply}>
              {chosen.length ? `Apply ${chosen.length}` : 'Apply'}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
      <Snackbar
        visible={!!toast}
        onDismiss={() => setToast(null)}
        duration={undo ? 8000 : 3500}
        action={undo ? { label: 'Undo', onPress: () => { void putBack(undo); } } : undefined}
      >
        {toast}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 14, width: '100%', maxWidth: 760, alignSelf: 'center' },
  h1: { fontFamily: FONT.semibold },
  card: { borderRadius: 18, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 16, paddingRight: 24, paddingVertical: 12 },
  iconAction: { margin: 0 },
  flex: { flex: 1 },
  empty: { padding: 4 },
  group: { gap: 8 },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  tidySpinner: { marginRight: 22 },
  dialog: { maxWidth: 560, width: '92%', alignSelf: 'center', maxHeight: '85%' },
  dialogScroll: { paddingHorizontal: 0 },
  tidyList: { paddingHorizontal: 20, paddingVertical: 12, gap: 14 },
  tidyItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  struck: { textDecorationLine: 'line-through' },
  search: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth },
});
