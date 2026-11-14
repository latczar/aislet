import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, Divider, Icon, IconButton, List, Surface, Switch, Text, TextInput, useTheme } from 'react-native-paper';
import { CATEGORIES } from '../brain';
import { useStore } from '../store';
import { confirm } from './confirm';
import { FONT } from './theme';

export function MemoryView({ onStartInterview }: { onStartInterview: () => void }) {
  const theme = useTheme();
  const { memories, addMemory, removeMemory, settings, updateSettings, startInterview, status, busy } = useStore();
  const [fact, setFact] = useState('');
  const card = [styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant }];

  const add = async () => {
    if (await addMemory(fact)) setFact('');
  };

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text variant="headlineSmall" style={styles.h1}>Memory</Text>
      <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
        What it knows about you. It learns from your chats, including feedback like "shorter please", and uses this in every
        conversation. You're in control: remove anything, any time.
      </Text>

      <Surface style={card} elevation={0}>
        <List.Item
          title="Get to know me"
          titleStyle={{ fontFamily: FONT.medium }}
          description="A short chat where it asks about you, one question at a time"
          descriptionNumberOfLines={2}
          left={(p) => <List.Icon {...p} icon="account-heart-outline" color={theme.colors.primary} />}
          right={() => (
            <Button
              mode="contained-tonal"
              compact
              disabled={!status?.ready || busy}
              onPress={() => { onStartInterview(); startInterview(); }}
            >
              Start
            </Button>
          )}
        />
        <Divider />
        <List.Item
          title="Learn from my chats"
          description="Saves lasting facts and preferences as you talk"
          right={() => <Switch value={settings.learn} onValueChange={(v) => updateSettings({ learn: v })} />}
        />
        <Divider />
        <View style={styles.addRow}>
          <TextInput
            mode="outlined"
            dense
            style={styles.flex}
            placeholder="Add a fact, e.g. I prefer short answers"
            value={fact}
            onChangeText={setFact}
            onSubmitEditing={add}
          />
          <Button mode="contained-tonal" onPress={add} disabled={!fact.trim()}>Add</Button>
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
                      right={() => (
                        <IconButton
                          icon="close"
                          size={18}
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
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 14, width: '100%', maxWidth: 760, alignSelf: 'center' },
  h1: { fontFamily: FONT.semibold },
  card: { borderRadius: 18, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  flex: { flex: 1 },
  empty: { padding: 4 },
  group: { gap: 8 },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
});
