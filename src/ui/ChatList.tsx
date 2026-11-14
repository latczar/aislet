import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { IconButton, Searchbar, Text, TouchableRipple, useTheme } from 'react-native-paper';
import { useStore } from '../store';
import type { ChatSummary } from '../types';
import { confirm } from './confirm';

function group(chats: ChatSummary[]): [string, ChatSummary[]][] {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const buckets: Record<string, ChatSummary[]> = { Today: [], Yesterday: [], 'Previous 7 days': [], Older: [] };
  for (const c of chats) {
    if (c.updated >= startOfToday) buckets.Today.push(c);
    else if (c.updated >= startOfToday - day) buckets.Yesterday.push(c);
    else if (c.updated >= startOfToday - 7 * day) buckets['Previous 7 days'].push(c);
    else buckets.Older.push(c);
  }
  return Object.entries(buckets).filter(([, list]) => list.length);
}

export function ChatList({ onPicked }: { onPicked?: () => void }) {
  const theme = useTheme();
  const { chats, chat, openChat, deleteChat } = useStore();
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return group(q ? chats.filter((c) => c.title.toLowerCase().includes(q)) : chats);
  }, [chats, query]);

  return (
    <View style={styles.flex}>
      {chats.length > 4 && (
        <Searchbar
          placeholder="Search chats"
          value={query}
          onChangeText={setQuery}
          style={[styles.search, { backgroundColor: theme.colors.surfaceVariant }]}
          inputStyle={styles.searchInput}
          elevation={0}
        />
      )}
      {!chats.length ? (
        <Text variant="bodyMedium" style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>Your chats will appear here.</Text>
      ) : !groups.length ? (
        <Text variant="bodyMedium" style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>No chats match “{query}”.</Text>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {groups.map(([label, list]) => (
            <View key={label}>
              <Text variant="labelMedium" style={[styles.section, { color: theme.colors.onSurfaceVariant }]}>{label}</Text>
              {list.map((c) => (
                <TouchableRipple
                  key={c.id}
                  onPress={() => { openChat(c.id); onPicked?.(); }}
                  style={[styles.row, c.id === chat?.id && { backgroundColor: theme.colors.secondaryContainer }]}
                  borderless
                >
                  <View style={styles.rowInner}>
                    <Text variant="bodyMedium" numberOfLines={1} style={styles.title}>{c.title}</Text>
                    <IconButton
                      icon="trash-can-outline"
                      size={17}
                      iconColor={theme.colors.onSurfaceVariant}
                      accessibilityLabel="Delete chat"
                      onPress={async () => {
                        if (await confirm('Delete this chat?', c.title)) deleteChat(c.id);
                      }}
                    />
                  </View>
                </TouchableRipple>
              ))}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  search: { marginHorizontal: 12, marginBottom: 8, height: 44, borderRadius: 12 },
  searchInput: { minHeight: 44, fontSize: 14 },
  list: { paddingHorizontal: 8, paddingBottom: 12 },
  section: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4 },
  row: { borderRadius: 12 },
  rowInner: { flexDirection: 'row', alignItems: 'center', paddingLeft: 12, minHeight: 44 },
  title: { flex: 1 },
  empty: { padding: 16 },
});
