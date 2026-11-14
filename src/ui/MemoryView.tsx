import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator, Button, Checkbox, Dialog, Divider, Icon, IconButton, List, Portal, Snackbar, Surface, Switch, Text, TextInput,
  useTheme,
} from 'react-native-paper';
import { CATEGORIES, type TidyChange } from '../brain';
import { useStore } from '../store';
import type { Memory } from '../types';
import { confirm } from './confirm';
import { Row } from './rows';
import { FONT } from './theme';

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

export function MemoryView({ onStartInterview }: { onStartInterview: () => void }) {
  const theme = useTheme();
  const {
    memories, addMemory, removeMemory, proposeTidy, applyTidy, settings, updateSettings, startInterview, status, busy,
  } = useStore();
  const [fact, setFact] = useState('');
  const [tidying, setTidying] = useState(false);
  const [changes, setChanges] = useState<TidyChange[] | null>(null);
  const [picked, setPicked] = useState<boolean[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const card = [styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant }];
  const chosen = changes?.filter((_, i) => picked[i]) ?? [];

  const add = async () => {
    if (await addMemory(fact)) setFact('');
  };

  const tidy = async () => {
    setTidying(true);
    try {
      const found = await proposeTidy();
      if (!found.length) setToast('All tidy: no duplicates or out-of-date facts found.');
      else {
        setPicked(found.map(() => true));
        setChanges(found);
      }
    } catch (e) {
      setToast((e as Error).message || "Couldn't check your memory just now.");
    } finally {
      setTidying(false);
    }
  };

  const apply = async () => {
    const n = chosen.length;
    await applyTidy(chosen);
    setChanges(null);
    setToast(`Tidied: ${n} ${n === 1 ? 'change' : 'changes'} made.`);
  };

  return (
    <View style={styles.flex}>
    <ScrollView contentContainerStyle={styles.page}>
      <Text variant="headlineSmall" style={styles.h1}>Memory</Text>
      <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
        What it knows about you. It learns from your chats, including feedback like "shorter please", and uses this in every
        conversation. You're in control: remove anything, any time.
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
          title="Learn from my chats"
          description="Saves lasting facts and preferences as you talk"
          left={(p) => <List.Icon {...p} icon="lightbulb-on-outline" color={theme.colors.primary} />}
          right={(p) => <Switch style={p.style} value={settings.learn} onValueChange={(v) => updateSettings({ learn: v })} />}
        />
        <Divider />
        <Row
          title="Tidy up memory"
          description={tidying ? 'Looking for duplicates and out-of-date facts…' : 'Finds duplicates and out-of-date facts. You approve each change.'}
          left={(p) => <List.Icon {...p} icon="broom" color={theme.colors.primary} />}
          right={(p) => (tidying
            ? <ActivityIndicator size={18} style={[p.style, styles.tidySpinner]} accessibilityLabel="Tidying" />
            : (
              <Button mode="contained-tonal" compact style={p.style} disabled={!status?.ready || busy || memories.length < 2} onPress={tidy}>
                Tidy up
              </Button>
            ))}
        />
        <Divider />
        <View style={styles.addRow}>
          <TextInput
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

      {memories.length === 0 ? (
        <Text variant="bodyMedium" style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>
          Nothing yet. Start "Get to know me", tell it about yourself in any chat, or add a fact above.
        </Text>
      ) : (
        CATEGORIES.map((c) => {
          const group = memories.filter((m) => (m.category ?? 'about') === c.id);
          if (!group.length) return null;
          return (
            <View key={c.id} style={styles.group}>
              <View style={styles.groupHead}>
                <Icon source={c.icon} size={18} color={theme.colors.onSurfaceVariant} />
                <Text variant="labelLarge" style={{ color: theme.colors.onSurfaceVariant }}>{c.title} · {group.length}</Text>
              </View>
              <Surface style={card} elevation={0}>
                {group.map((m, i) => (
                  <View key={m.id}>
                    {i > 0 && <Divider />}
                    <List.Item
                      title={m.fact}
                      titleNumberOfLines={4}
                      description={m.added}
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
              </Surface>
            </View>
          );
        })
      )}
    </ScrollView>

      <Portal>
        <Dialog visible={!!changes} onDismiss={() => setChanges(null)} style={styles.dialog}>
          <Dialog.Title style={{ fontFamily: FONT.semibold }}>Suggested changes</Dialog.Title>
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
      <Snackbar visible={!!toast} onDismiss={() => setToast(null)} duration={3500}>{toast}</Snackbar>
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
});
