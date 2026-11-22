// Layout: a sidebar on the PC; on the phone, a menu (☰) that slides in with chats, Memory, Notes and Settings.
import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Image, Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Button, Divider, Drawer, Icon, IconButton, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { APP_NAME } from '../config';
import { useStore } from '../store';
import { tap } from './actions';
import { useBackCloses } from './back';
import { ChatList } from './ChatList';
import { ChatHeader, ChatView } from './ChatView';
import { MemoryView } from './MemoryView';
import { NotesView } from './NotesView';
import { SettingsView } from './SettingsView';
import { backUp } from '../backup';
import { KEYS, save } from '../storage';
import { useKeyboardInset } from './keyboard';
import { type Incoming, useIncomingShare } from './share';
import { focusSoon, useShortcuts } from './shortcuts';
import { type WidgetAction, useWidgetLinks } from '../widget';
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
  const { newChat, busy, stop, snapshot, startView, memories, notes } = useStore();
  const [view, setView] = useState<ViewKey>(() => (ROUTES.some((r) => r.key === startView) ? (startView as ViewKey) : 'chat'));
  const [chatsOpen, setChatsOpen] = useState(false);
  const [shared, setShared] = useState<Incoming | null>(null);     // arrived from another app
  const [incoming, setIncoming] = useState<Incoming | null>(null); // handed to the message box
  const keyboard = useKeyboardInset();
  const wide = width >= 900;
  // On the phone, Back from Memory, Notes or Settings goes to the chat instead of leaving the app.
  const toChat = useCallback(() => setView('chat'), []);
  useBackCloses(!wide && view !== 'chat' && !chatsOpen, toChat);
  const menu = wide ? undefined : (
    <IconButton icon="menu" onPress={() => { tap(); setChatsOpen(true); }} accessibilityLabel="Menu" />
  );

  // "Share to Aislet" from another app opens a new chat with it in the message box. A reply that's
  // still being written is stopped first, since a new chat can't start until it ends.
  useIncomingShare((s) => {
    if (busy) stop();
    setShared(s);
  });
  useEffect(() => {
    if (!shared || busy) return;
    newChat();
    setView('chat');
    setChatsOpen(false);
    setIncoming(shared);
    setShared(null);
  }, [shared, busy, newChat]);
  const takeIncoming = useCallback(() => setIncoming(null), []);

  // The home-screen widget opens a new chat, ready to type in or, from its round button, talking hands-free.
  const [widget, setWidget] = useState<WidgetAction | null>(null);
  const [talkRequest, setTalkRequest] = useState(0);
  useWidgetLinks((action) => {
    if (busy) stop();
    setWidget(action);
  });
  useEffect(() => {
    if (!widget || busy) return;
    newChat();
    setView('chat');
    setChatsOpen(false);
    setWidget(null);
    if (widget === 'talk') setTalkRequest(Date.now());
    else focusSoon('message');
  }, [widget, busy, newChat]);

  // Remember the screen, so coming back to the app opens it again.
  useEffect(() => {
    save(KEYS.lastView, view).catch(() => undefined);
  }, [view]);

  // The daily encrypted backup (phone, when it's on): checked at launch and whenever the app comes back.
  useEffect(() => {
    const check = () => { backUp(snapshot()).catch(() => undefined); }; // a failure shows in Settings
    const first = setTimeout(check, 5000); // after the app has settled
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') check(); });
    return () => {
      clearTimeout(first);
      sub.remove();
    };
  }, [snapshot]);

  const content =
    view === 'chat' ? <ChatView onOpenSettings={() => setView('settings')} incoming={incoming} onIncomingTaken={takeIncoming} talkRequest={talkRequest} />
      : view === 'memory' ? <MemoryView onStartInterview={() => setView('chat')} menu={menu} />
        : view === 'notes' ? <NotesView menu={menu} />
          : <SettingsView menu={menu} />;

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

  const go = (key: ViewKey) => { tap(); setView(key); setChatsOpen(false); };
  return (
    <View
      ref={keyboard.ref}
      onLayout={keyboard.onLayout}
      style={[styles.flex, { backgroundColor: theme.colors.background, paddingTop: insets.top, paddingBottom: keyboard.inset }]}
    >
      {view === 'chat' && (
        <ChatHeader
          left={menu}
          right={<IconButton icon="square-edit-outline" onPress={startChat} disabled={busy} accessibilityLabel="New chat" />}
        />
      )}
      <View style={[styles.flex, { paddingBottom: keyboard.open && keyboard.inset > 0 ? 0 : insets.bottom }]}>{content}</View>

      <Modal visible={chatsOpen} transparent animationType="fade" onRequestClose={() => setChatsOpen(false)} statusBarTranslucent>
        <View style={styles.sheetRow}>
          <View style={[styles.sheet, { backgroundColor: theme.colors.background, paddingTop: insets.top + 12, paddingBottom: insets.bottom }]}>
            <View style={styles.sheetHead}>
              <Image source={require('../../assets/icon.png')} style={styles.brandIcon} />
              <Text variant="titleLarge" style={[styles.flex, styles.brandText]}>{APP_NAME}</Text>
            </View>
            {/* The four places as tiles, with what's in them, above the chats: quicker to reach than a list at the bottom. */}
            <View style={styles.tiles}>
              {ROUTES.map((r) => {
                const on = view === r.key;
                const count = r.key === 'memory' ? `${memories.filter((m) => !m.until).length} facts`
                  : r.key === 'notes' ? `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}` : '';
                return (
                  <Pressable
                    key={r.key} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => go(r.key)}
                    style={({ pressed }) => [styles.tile, {
                      backgroundColor: on ? theme.colors.secondaryContainer : pressed ? theme.colors.surfaceVariant : theme.colors.surface,
                      borderColor: theme.colors.outlineVariant,
                    }]}
                  >
                    <Icon source={on ? r.focusedIcon : r.unfocusedIcon} size={22} color={on ? theme.colors.onSecondaryContainer : theme.colors.primary} />
                    <Text variant="labelMedium" numberOfLines={1} style={styles.tileText}>{r.title}</Text>
                    {!!count && <Text variant="labelSmall" numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant }}>{count}</Text>}
                  </Pressable>
                );
              })}
            </View>
            <Button mode="contained" icon="plus" onPress={() => { startChat(); setChatsOpen(false); }} disabled={busy} style={styles.newChat} contentStyle={styles.newChatInner}>
              New chat
            </Button>
            <View style={styles.flex}>
              <ChatList onPicked={() => { setView('chat'); setChatsOpen(false); }} />
            </View>
          </View>
          <Pressable style={styles.scrim} onPress={() => setChatsOpen(false)} accessibilityLabel="Close menu" />
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
  tiles: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingBottom: 12 },
  tile: { flex: 1, minWidth: 0, alignItems: 'center', gap: 2, paddingVertical: 10, paddingHorizontal: 2, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  tileText: { fontFamily: FONT.medium },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
});
