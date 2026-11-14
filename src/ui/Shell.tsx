// Layout: a sidebar on the PC, a header and bottom tabs on the phone.
import React, { useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { BottomNavigation, Button, Divider, Drawer, IconButton, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { APP_NAME } from '../config';
import { useStore } from '../store';
import { tap } from './actions';
import { ChatList } from './ChatList';
import { ChatHeader, ChatView } from './ChatView';
import { MemoryView } from './MemoryView';
import { NotesView } from './NotesView';
import { SettingsView } from './SettingsView';
import { focusSoon, useShortcuts } from './shortcuts';
import { FONT } from './theme';

type ViewKey = 'chat' | 'memory' | 'notes' | 'settings';
const ROUTES = [
  { key: 'chat', title: 'Chat', focusedIcon: 'message-text', unfocusedIcon: 'message-text-outline' },
  { key: 'memory', title: 'Memory', focusedIcon: 'brain', unfocusedIcon: 'brain' },
  { key: 'notes', title: 'Notes', focusedIcon: 'note-text', unfocusedIcon: 'note-text-outline' },
  { key: 'settings', title: 'Settings', focusedIcon: 'cog', unfocusedIcon: 'cog-outline' },
] as const;

export function Shell() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { newChat, busy } = useStore();
  const [view, setView] = useState<ViewKey>('chat');
  const [chatsOpen, setChatsOpen] = useState(false);
  const wide = width >= 900;

  const content =
    view === 'chat' ? <ChatView onOpenSettings={() => setView('settings')} />
      : view === 'memory' ? <MemoryView onStartInterview={() => setView('chat')} />
        : view === 'notes' ? <NotesView />
          : <SettingsView />;

  const startChat = () => {
    tap();
    newChat();
    setView('chat');
  };

  useShortcuts({
    newChat: () => {
      if (busy) return;
      startChat();
      setChatsOpen(false);
      focusSoon('message');
    },
    typeMessage: () => {
      setChatsOpen(false);
      setView('chat');
      focusSoon('message');
    },
    searchChats: () => {
      if (!wide) setChatsOpen(true);
      focusSoon('search');
    },
  });

  if (wide) {
    return (
      <View style={[styles.row, { backgroundColor: theme.colors.background }]}>
        <View style={[styles.sidebar, { backgroundColor: theme.colors.surfaceVariant, borderRightColor: theme.colors.outlineVariant }]}>
          <View style={styles.brand}>
            <Image source={require('../../assets/icon.png')} style={styles.brandIcon} />
            <Text variant="titleMedium" style={styles.brandText}>{APP_NAME}</Text>
          </View>
          <Button mode="contained" icon="plus" onPress={startChat} disabled={busy} style={styles.newChat} contentStyle={styles.newChatInner}>
            New chat
          </Button>
          <View style={styles.flex}>
            <ChatList onPicked={() => setView('chat')} />
          </View>
          <Divider />
          <Drawer.Section showDivider={false} style={styles.nav}>
            {ROUTES.slice(1).map((r) => (
              <Drawer.Item
                key={r.key}
                label={r.title}
                icon={view === r.key ? r.focusedIcon : r.unfocusedIcon}
                active={view === r.key}
                onPress={() => setView(r.key)}
              />
            ))}
          </Drawer.Section>
        </View>
        <View style={styles.flex}>
          {view === 'chat' && <ChatHeader />}
          {content}
        </View>
      </View>
    );
  }

  const index = ROUTES.findIndex((r) => r.key === view);
  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background, paddingTop: insets.top }]}>
      {view === 'chat' && (
        <ChatHeader
          left={<IconButton icon="menu" onPress={() => { tap(); setChatsOpen(true); }} accessibilityLabel="Chats" />}
          right={<IconButton icon="square-edit-outline" onPress={startChat} disabled={busy} accessibilityLabel="New chat" />}
        />
      )}
      <View style={styles.flex}>{content}</View>
      <BottomNavigation.Bar
        navigationState={{ index, routes: ROUTES as unknown as { key: string; title: string }[] }}
        onTabPress={({ route }) => { tap(); setView(route.key as ViewKey); }}
        safeAreaInsets={{ bottom: insets.bottom }}
        style={{ backgroundColor: theme.colors.background, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.outlineVariant }}
        activeIndicatorStyle={{ backgroundColor: theme.colors.secondaryContainer }}
      />

      <Modal visible={chatsOpen} transparent animationType="fade" onRequestClose={() => setChatsOpen(false)} statusBarTranslucent>
        <View style={styles.sheetRow}>
          <View style={[styles.sheet, { backgroundColor: theme.colors.background, paddingTop: insets.top + 12, paddingBottom: insets.bottom }]}>
            <View style={styles.sheetHead}>
              <Image source={require('../../assets/icon.png')} style={styles.brandIcon} />
              <Text variant="titleLarge" style={[styles.flex, styles.brandText]}>Chats</Text>
            </View>
            <Button mode="contained" icon="plus" onPress={() => { startChat(); setChatsOpen(false); }} disabled={busy} style={styles.newChat} contentStyle={styles.newChatInner}>
              New chat
            </Button>
            <ChatList onPicked={() => setChatsOpen(false)} />
          </View>
          <Pressable style={styles.scrim} onPress={() => setChatsOpen(false)} accessibilityLabel="Close chats" />
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flex: 1, flexDirection: 'row' },
  sidebar: { width: 284, paddingTop: 18, borderRightWidth: StyleSheet.hairlineWidth },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingBottom: 16 },
  brandIcon: { width: 30, height: 30, borderRadius: 9 },
  brandText: { fontFamily: FONT.semibold },
  newChat: { marginHorizontal: 16, marginBottom: 10, borderRadius: 14 },
  newChatInner: { height: 44, justifyContent: 'flex-start' },
  nav: { paddingVertical: 8 },
  sheetRow: { flex: 1, flexDirection: 'row' },
  sheet: { width: '84%', maxWidth: 360 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingBottom: 14 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
});
