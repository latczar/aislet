import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, IconButton, Searchbar, Text, TouchableRipple, useTheme } from 'react-native-paper';
import { useStore } from '../store';
import type { ChatSummary } from '../types';
import { tap } from './actions';
import { confirm } from './confirm';
import { registerFocus } from './shortcuts';

function group(chats: ChatSummary[]): [string, ChatSummary[]][] {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const buckets: Record<string, ChatSummary[]> = { Pinned: [], Today: [], Yesterday: [], 'Previous 7 days': [], Older: [] };
  for (const c of [...chats].sort((a, b) => b.updated - a.updated)) {
    if (c.pinned) buckets.Pinned.push(c);
    else if (c.updated >= startOfToday) buckets.Today.push(c);
    else if (c.updated >= startOfToday - day) buckets.Yesterday.push(c);
    else if (c.updated >= startOfToday - 7 * day) buckets['Previous 7 days'].push(c);
    else buckets.Older.push(c);
  }
  return Object.entries(buckets).filter(([, list]) => list.length);
}

export function ChatList({ onPicked }: { onPicked?: () => void }) {
  const theme = useTheme();
  const { chats, chat, openChat, deleteChat, pinChat, archiveChats } = useStore();
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const search = useRef<{ focus(): void }>(null);
  const searchable = chats.length > 4;
  useEffect(() => (searchable ? registerFocus('search', () => search.current?.focus()) : undefined), [searchable]);
  const { groups, archived } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const found = q ? chats.filter((c) => c.title.toLowerCase().includes(q)) : chats;
    return {
      groups: group(found.filter((c) => !c.archived)),
      archived: found.filter((c) => c.archived).sort((a, b) => b.updated - a.updated),
    };
  }, [chats, query]);
  const muted = { color: theme.colors.onSurfaceVariant };

  const row = (c: ChatSummary) => (
    <TouchableRipple
      key={c.id}
      onPress={() => { openChat(c.id); onPicked?.(); }}
      style={[styles.row, c.id === chat?.id && { backgroundColor: theme.colors.secondaryContainer }]}
      borderless
    >
      <View style={styles.rowInner}>
        <Text variant="bodyMedium" numberOfLines={1} style={[styles.title, c.archived && muted]}>{c.title}</Text>
        {!c.archived && (
          <IconButton
            icon={c.pinned ? 'pin' : 'pin-outline'}
            size={17}
            iconColor={c.pinned ? theme.colors.primary : theme.colors.onSurfaceVariant}
            style={styles.rowAction}
            accessibilityLabel={c.pinned ? 'Unpin chat' : 'Pin chat'}
            onPress={() => { tap(); pinChat(c.id, !c.pinned); }}
          />
        )}
        <IconButton
          icon={c.archived ? 'archive-arrow-up-outline' : 'archive-arrow-down-outline'}
          size={17}
          iconColor={theme.colors.onSurfaceVariant}
          style={styles.rowAction}
          accessibilityLabel={c.archived ? 'Unarchive chat' : 'Archive chat'}
          onPress={() => { tap(); archiveChats([c.id], !c.archived); }}
        />
        <IconButton
          icon="trash-can-outline"
          size={17}
          iconColor={theme.colors.onSurfaceVariant}
          style={styles.rowAction}
          accessibilityLabel="Delete chat"
          onPress={async () => {
            if (await confirm('Delete this chat?', c.title)) deleteChat(c.id);
          }}
        />
      </View>
    </TouchableRipple>
  );

  return (
    <View style={styles.flex}>
      {searchable && (
        <Searchbar
          ref={search as never}
          placeholder="Search chats"
          value={query}
          onChangeText={setQuery}
          style={[styles.search, { backgroundColor: theme.colors.surfaceVariant }]}
          inputStyle={styles.searchInput}
          elevation={0}
        />
      )}
      {!chats.length ? (
        <Text variant="bodyMedium" style={[styles.empty, muted]}>Your chats will appear here.</Text>
      ) : !groups.length && !archived.length ? (
        <Text variant="bodyMedium" style={[styles.empty, muted]}>No chats match “{query}”.</Text>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {!groups.length && !query.trim() && (
            <Text variant="bodyMedium" style={[styles.empty, muted]}>All your chats are archived.</Text>
          )}
          {groups.map(([label, list]) => (
            <View key={label}>
              <Text variant="labelMedium" style={[styles.section, muted]}>{label}</Text>
              {list.map(row)}
            </View>
          ))}
          {archived.length > 0 && (
            <View>
              <View style={styles.archivedHead}>
                <TouchableRipple
                  onPress={() => { tap(); setShowArchived((s) => !s); }}
                  style={styles.archivedToggle}
                  borderless
                  accessibilityRole="button"
                  accessibilityLabel={`${showArchived ? 'Hide' : 'Show'} archived chats`}
                >
                  <Text variant="labelMedium" style={muted}>
                    Archived ({archived.length}) {showArchived ? '▾' : '▸'}
                  </Text>
                </TouchableRipple>
                {showArchived && archived.length > 1 && (
                  <Button compact mode="text" onPress={() => { tap(); archiveChats(archived.map((c) => c.id), false); }}>
                    Unarchive all
                  </Button>
                )}
              </View>
              {(showArchived || !!query.trim()) && archived.map(row)}
            </View>
          )}
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
  rowInner: { flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 4, minHeight: 44 },
  title: { flex: 1 },
  rowAction: { margin: 0 },
  empty: { padding: 16 },
  archivedHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8 },
  archivedToggle: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
});
