import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, View } from 'react-native';
import {
  Avatar, Button, Chip, Divider, IconButton, List, Menu, ProgressBar, RadioButton, SegmentedButtons, Snackbar, Surface, Switch, Text, useTheme,
} from 'react-native-paper';
import { PageTitle } from './PageTitle';
import { type BackupStatus, backUp, backupStatus, backupSupported, openBackup, pickBackupFile, setUpBackups, turnOffBackups } from '../backup';
import { APP_NAME } from '../config';
import { findLaptops } from '../discover';
import { engine } from '../engine';
import type { ModelInfo, ModelManager } from '../engine/types';
import { STALE_PC_KEY, UNREACHABLE, hubNewCode, hubPairing, hubPing, isLinkKey, normaliseAddress, pairWith } from '../hub';
import { KIWIX_FOLDER, LIBRARY_FOLDER, type LibraryBook, describeBook } from '../library';
import { cleanCode, isPairingCode } from '../link';
import { makePairLink } from '../pairLink';
import { useStore } from '../store';
import type { Accel, AnswerLength, Appearance, Performance } from '../types';
import { useBackCloses } from './back';
import { Field } from './Field';
import { deviceLanguage, languageName } from './languages';
import { formatWhen } from './confirm';
import { confirm, formatSize } from './confirm';
import { cancelDownload, startDownload, useDownload } from './downloads';
import { PairQr } from './PairQr';
import { ScanPair } from './ScanPair';
import { Lead, Row } from './rows';
import { SHORTCUTS } from './shortcuts';
import { FONT, STATUS_COLOURS } from './theme';
import { offlineLanguages, voiceSupported } from './voice';
import { addWidget, widgetSupported } from '../widget';

function Section({ title, children, footer }: { title: string; children: React.ReactNode; footer?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <Text variant="labelLarge" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>{title}</Text>
      <Surface style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant }]} elevation={0}>
        {children}
      </Surface>
      {footer && <Text variant="bodySmall" style={[styles.footer, { color: theme.colors.onSurfaceVariant }]}>{footer}</Text>}
    </View>
  );
}

function ModelRow({ model, selected, onSelect, onChanged, icon = 'text-search', replaces = [] }: {
  model: ModelInfo; selected?: boolean; onSelect?: () => void; onChanged: () => void; icon?: string;
  replaces?: ModelInfo[]; // the phone keeps one AI model: getting another deletes these once it's downloaded
}) {
  const theme = useTheme();
  const dl = useDownload(model.id);
  return (
    <View>
      <Row
        title={model.name}
        description={`${model.note} ${formatSize(model.size)}`}
        onPress={model.downloaded && onSelect ? onSelect : undefined}
        left={(p) =>
          onSelect ? (
            <Lead style={p.style}>
              <RadioButton value={model.id} status={selected ? 'checked' : 'unchecked'} disabled={!model.downloaded} onPress={onSelect} />
            </Lead>
          ) : (
            <List.Icon {...p} icon={icon} />
          )
        }
        right={(p) =>
          dl.progress !== null ? (
            <Button mode="contained-tonal" compact style={p.style} onPress={() => cancelDownload(model.id)}>Cancel</Button>
          ) : model.downloaded ? (
            <IconButton
              icon="trash-can-outline"
              style={[styles.iconAction, p.style]}
              iconColor={theme.colors.onSurfaceVariant}
              accessibilityLabel={`Delete ${model.name}`}
              onPress={async () => {
                if (await confirm(`Delete ${model.name}?`, `This frees ${formatSize(model.size)}. You can download it again later.`)) {
                  await engine.models!.remove(model.id);
                  onChanged();
                }
              }}
            />
          ) : (
            <Button
              mode="contained-tonal" compact style={p.style}
              onPress={async () => {
                if (replaces.length) {
                  const names = replaces.map((r) => r.name).join(' and ');
                  const freed = formatSize(replaces.reduce((n, r) => n + r.size, 0));
                  if (!await confirm(`Switch to ${model.name}?`, `Aislet keeps one AI model on the phone. It downloads ${model.name} (${formatSize(model.size)}), then deletes ${names} to free ${freed}. Until then, ${names} keeps working.`, 'Switch')) return;
                }
                startDownload(model.id, async () => {
                  onSelect?.();
                  for (const r of replaces) await engine.models!.remove(r.id).catch(() => undefined);
                  onChanged();
                });
              }}
            >
              Get
            </Button>
          )
        }
      />
      {dl.progress !== null && (
        <View style={styles.progress}>
          <ProgressBar progress={dl.progress} style={styles.bar} />
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {Math.round(dl.progress * 100)}% of {formatSize(model.size)} · keep the app open
          </Text>
        </View>
      )}
      {dl.problem && <Text variant="bodySmall" style={[styles.progress, { color: theme.colors.error }]}>{dl.problem}</Text>}
    </View>
  );
}

/** The phone's chat models to list: the recommended one first (marked), then any on the phone or chosen, then the rest. */
function shownModels(models: ModelManager, chosen: string, all: boolean): ModelInfo[] {
  const rec = models.recommended();
  return models.chatModels()
    .filter((m) => m.id === rec || m.downloaded || m.id === chosen || (all && !m.legacy))
    .sort((a, b) => Number(b.id === rec) - Number(a.id === rec))
    .map((m) => (m.id === rec ? { ...m, note: `Recommended for this phone. ${m.note}` } : m));
}

/** Your own files are listed one by one up to this many (anything needing attention first); the rest are counted. */
const SHOWN_FILES = 12;
const FILE_ICONS: Record<string, string> = {
  pdf: 'file-pdf-box', epub: 'book-outline', text: 'file-document-outline', markdown: 'language-markdown-outline', html: 'web',
};

/** Offline libraries searched when answering: your own files (phone and PC) and Kiwix .zim files (phone). */
function Libraries({ onToast }: { onToast: (message: string) => void }) {
  const theme = useTheme();
  const {
    libraries, settings, updateSettings, refreshLibraries, allowLibraries, moveLibraries, removeLibrary, openLibraryFolder,
  } = useStore();
  const [moving, setMoving] = useState(false);
  const { access, books, elsewhere, folder, skipped, reading, problem } = libraries;
  const phone = Platform.OS !== 'web';

  const kiwix = books.filter((b) => b.format === 'zim');
  const order = (b: LibraryBook) => (b.problem ? 0 : b.pending ? 1 : 2);
  const own = books.filter((b) => b.format !== 'zim').sort((a, b) => order(a) - order(b) || a.title.localeCompare(b.title));
  const more = own.length - SHOWN_FILES;
  const fromKiwix = elsewhere.every((b) => b.path.includes(`/${KIWIX_FOLDER}/`));
  const names = elsewhere.map((b) => b.title).join(', ');
  const fileIcon = (b: LibraryBook) =>
    b.problem ? 'alert-circle-outline' : b.pending ? 'progress-clock' : FILE_ICONS[b.format] ?? 'file-outline';

  const rows: React.ReactNode[] = [];
  if (!access) {
    rows.push(
      <Row
        key="allow"
        title={libraries.lostAccess ? 'Allow access again' : 'Allow access to libraries'}
        description={libraries.lostAccess
          ? '"All files access" has been switched off, so your libraries aren\'t being searched. Allow it again to use them.'
          : 'Answer from your own PDFs, ebooks and documents, and from Kiwix libraries such as Wikipedia. Needs "All files access".'}
        left={(p) => <List.Icon {...p} icon="folder-key-outline" />}
        right={(p) => <Button mode="contained-tonal" compact style={p.style} onPress={() => allowLibraries().catch((e) => onToast((e as Error).message))}>Allow</Button>}
      />,
    );
  }
  if (access || books.length > 0) {
    rows.push(
      <Row
        key="use"
        title="Use libraries in answers"
        description={phone ? "Searched on this phone, even when the laptop's AI answers" : 'Searched on this computer'}
        left={(p) => <List.Icon {...p} icon="bookshelf" />}
        right={(p) => (
          <Switch
            style={p.style}
            value={settings.useLibraries}
            onValueChange={async (v) => {
              await updateSettings({ useLibraries: v });
              if (v) refreshLibraries(); // reads any files added while it was off
            }}
          />
        )}
      />,
    );
    if (settings.useLibraries) {
      rows.push(
        <View key="mode" style={styles.pad}>
          <Text variant="labelLarge">When a library matches</Text>
          <SegmentedButtons
            value={settings.libraryMode ?? 'ask'}
            onValueChange={(v) => updateSettings({ libraryMode: v as 'ask' | 'auto' })}
            buttons={[
              { value: 'ask', label: 'Ask first', icon: 'message-question-outline' },
              { value: 'auto', label: 'Use it', icon: 'check-all' },
            ]}
          />
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {(settings.libraryMode ?? 'ask') === 'ask'
              ? 'Answers straight away, then offers what a library found. Quicker, and only what you choose goes in.'
              : 'Strong matches go into the answer straight away, with the source named.'}
          </Text>
        </View>,
      );
      for (const [book, choice] of Object.entries(settings.libraryChoice ?? {})) {
        rows.push(
          <Row
            key={`choice-${book}`}
            title={book}
            description={choice === 'always' ? 'Always used' : 'Never suggested'}
            left={(p) => <List.Icon {...p} icon={choice === 'always' ? 'check-all' : 'close'} />}
            right={(p) => (
              <Button
                mode="contained-tonal" compact style={p.style}
                onPress={() => {
                  const next = { ...settings.libraryChoice };
                  delete next[book];
                  updateSettings({ libraryChoice: next });
                }}
              >
                Reset
              </Button>
            )}
          />,
        );
      }
    }
  }
  if (openLibraryFolder && folder) {
    rows.push(
      <Row
        key="folder"
        title="Library folder"
        description={folder}
        left={(p) => <List.Icon {...p} icon="folder-outline" />}
        right={(p) => <Button mode="contained-tonal" compact style={p.style} onPress={() => openLibraryFolder().catch((e) => onToast((e as Error).message))}>Open</Button>}
      />,
    );
  }
  for (const b of kiwix) {
    rows.push(
      <Row
        key={b.path}
        title={b.title}
        description={describeBook(b, formatSize(b.size))}
        left={(p) => <List.Icon {...p} icon={b.problem ? 'alert-circle-outline' : 'book-open-page-variant-outline'} />}
        right={phone ? (p) => ( // the laptop only lists Kiwix libraries (it can't read them yet), so they can't be deleted there
          <IconButton
            icon="trash-can-outline"
            style={[styles.iconAction, p.style]}
            iconColor={theme.colors.onSurfaceVariant}
            accessibilityLabel={`Delete ${b.title}`}
            onPress={async () => {
              if (await confirm(`Delete ${b.title}?`, `This deletes the file and frees ${formatSize(b.size)}. You can download it again from library.kiwix.org.`)) {
                await removeLibrary(b.path).catch((e) => onToast((e as Error).message));
              }
            }}
          />
        ) : undefined}
      />,
    );
  }
  // Your own files have no delete button: Aislet only reads them.
  for (const b of own.slice(0, SHOWN_FILES)) {
    rows.push(
      <Row
        key={b.path}
        title={b.title}
        description={describeBook(b, formatSize(b.size), reading)}
        left={(p) => <List.Icon {...p} icon={fileIcon(b)} color={b.problem ? theme.colors.error : p.color} />}
      />,
    );
  }
  if (more > 0) {
    rows.push(
      <Row
        key="more"
        title={`${more.toLocaleString('en-GB')} more ${more === 1 ? 'file' : 'files'}`}
        description={reading ? 'Reading…' : 'Searched like the ones above'}
        left={(p) => <List.Icon {...p} icon="file-multiple-outline" />}
      />,
    );
  }
  if (skipped > 0) {
    rows.push(
      <Row
        key="skipped"
        title={`${skipped.toLocaleString('en-GB')} ${skipped === 1 ? "file wasn't" : "files weren't"} read`}
        description="There are too many files in the library folder. Move some to another folder."
        left={(p) => <List.Icon {...p} icon="alert-circle-outline" color={theme.colors.error} />}
      />,
    );
  }
  if (problem) {
    rows.push(
      <Row
        key="problem"
        title="Your files couldn't be read"
        description={problem}
        left={(p) => <List.Icon {...p} icon="alert-circle-outline" color={theme.colors.error} />}
        right={(p) => <Button mode="contained-tonal" compact style={p.style} onPress={() => refreshLibraries()}>Try again</Button>}
      />,
    );
  }
  if (elsewhere.length > 0) {
    rows.push(
      <Row
        key="move"
        title={fromKiwix ? `Move ${elsewhere.length === 1 ? 'a library' : `${elsewhere.length} libraries`} from Kiwix` : `Move ${elsewhere.length === 1 ? 'a library' : `${elsewhere.length} libraries`} into Aislet`}
        description={`${names}. They're moved, not copied, so no extra space is used.`}
        left={(p) => <List.Icon {...p} icon="folder-move-outline" />}
        right={(p) => (
          <Button
            mode="contained-tonal"
            compact
            style={p.style}
            loading={moving}
            disabled={moving}
            onPress={async () => {
              const ok = await confirm(
                `Move ${elsewhere.length === 1 ? elsewhere[0].title : `${elsewhere.length} libraries`}?`,
                `They'll be in ${LIBRARY_FOLDER} on your phone. ${fromKiwix ? "Kiwix won't see them afterwards, and you can uninstall Kiwix without losing them." : 'Other apps can still open them there.'}`,
                'Move',
              );
              if (!ok) return;
              setMoving(true);
              try {
                onToast(await moveLibraries());
              } catch (e) {
                onToast((e as Error).message);
              } finally {
                setMoving(false);
              }
            }}
          >
            Move
          </Button>
        )}
      />,
    );
  }
  if (access && books.length === 0 && elsewhere.length === 0 && !problem) {
    rows.push(
      <Row
        key="empty"
        title="No libraries yet"
        description={phone
          ? `Put your own PDFs, ebooks (EPUB), text or web pages in ${LIBRARY_FOLDER} on your phone. Kiwix libraries such as Wikipedia (.zim files from library.kiwix.org) go there too.`
          : 'Put your own PDFs, ebooks (EPUB), text or web pages in the library folder.'}
        left={(p) => <List.Icon {...p} icon="book-plus-outline" />}
      />,
    );
  }
  return <>{rows.map((row, i) => <View key={i}>{i > 0 && <Divider />}{row}</View>)}</>;
}

/** PC: a QR code for the phone's camera, and the address and code to type in instead. */
function PairPhone() {
  const theme = useTheme();
  const { hub } = useStore();
  const [info, setInfo] = useState<{ code: string; salt: string; urls: string[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    hubPairing().then(setInfo).catch((e) => setProblem((e as Error).message));
  }, []);
  if (problem) return <Text variant="bodyMedium" style={[styles.pad, { color: theme.colors.error }]}>{problem === STALE_PC_KEY ? problem : `The hub isn't running: ${problem}`}</Text>;
  if (!info) return <Text variant="bodyMedium" style={styles.pad}>Loading…</Text>;
  const muted = { color: theme.colors.onSurfaceVariant };
  const address = info.urls[0];
  return (
    <View style={styles.pad}>
      {address ? (
        <View style={styles.pairTop}>
          <PairQr link={makePairLink(address, info.code, info.salt)} />
          <View style={styles.pairText}>
            <Text variant="titleMedium" style={{ fontFamily: FONT.semibold }}>Scan with {APP_NAME} on your phone</Text>
            <Text variant="bodyMedium" style={muted}>
              On the phone, open {APP_NAME} → Settings → Home, tap Scan the laptop's code and point it at this one.
            </Text>
            <Text variant="bodySmall" style={muted}>
              Install {APP_NAME} on the phone first. Both need to be on the same Wi-Fi.
            </Text>
          </View>
        </View>
      ) : (
        <Text variant="bodyMedium" style={muted}>Connect this laptop to Wi-Fi to pair your phone.</Text>
      )}
      <Divider />
      <Text variant="bodyMedium" style={muted}>
        Or, on the phone, open {APP_NAME} → Settings → Home, tap Find my laptop (or type the address), then enter the code:
      </Text>
      <View style={styles.pairGrid}>
        <View style={styles.pairRow}>
          <Text variant="labelLarge" style={[styles.pairLabel, muted]}>Address</Text>
          <Text variant="titleMedium" selectable style={styles.mono}>{address?.replace('http://', '').replace(':8766', '') ?? 'Connect to Wi-Fi first'}</Text>
        </View>
        <View style={styles.pairRow}>
          <Text variant="labelLarge" style={[styles.pairLabel, muted]}>Code</Text>
          <Text variant="titleLarge" selectable style={[styles.mono, { color: theme.colors.primary, letterSpacing: 3 }]}>
            {info.code.length === 10 ? `${info.code.slice(0, 5)} ${info.code.slice(5)}` : info.code}
          </Text>
        </View>
      </View>
      <Text variant="bodySmall" style={muted}>
        {/Windows/.test(navigator.userAgent)
          ? 'The first time, Windows may ask whether Python can use the network: choose Allow.'
          : "If the phone can't find this computer, allow port 8766 through its firewall on your home network."}
        {hub.lastSync ? ` Last synced ${formatWhen(hub.lastSync)}.` : ''}
      </Text>
      <Button
        mode="text"
        icon="refresh"
        style={[styles.leftButton, styles.textButtonFlush]}
        onPress={async () => {
          if (await confirm('Make a new code?', 'Phones using the old code will need the new one before they can sync again.', 'New code')) {
            hubNewCode().then(setInfo).catch((e) => setProblem((e as Error).message));
          }
        }}
      >
        New code
      </Button>
    </View>
  );
}

/** Phone, paired: the laptop's address, and a search for it if the router has given it a new one. */
function LaptopAddress() {
  const theme = useTheme();
  const { settings, updateSettings, refreshStatus } = useStore();
  const [progress, setProgress] = useState<number | null>(null); // while looking
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const cancel = useRef<AbortController | null>(null);
  useEffect(() => () => cancel.current?.abort(), []);

  const findAgain = async () => {
    setProblem(null);
    setNote(null);
    const controller = new AbortController();
    cancel.current = controller;
    setProgress(0);
    const result = { match: '', key: '' };
    const checks: Promise<void>[] = [];
    const key = settings.hubKey;
    try {
      await findLaptops(
        (a) => {
          // Only a laptop that proves it knows this phone's key is ours (or, for a phone paired before the
          // private link, accepts its code).
          const base = normaliseAddress(a);
          checks.push((isLinkKey(key) ? hubPing({ base, key, kind: 'phone' }).then(() => key) : pairWith(base, key).then((r) => r.key))
            .then((proven) => {
              if (!result.match) {
                result.match = a;
                result.key = proven;
                controller.abort(); // found it: stop looking
              }
            })
            .catch(() => undefined));
        },
        setProgress,
        controller.signal,
      );
      await Promise.all(checks);
    } catch (e) {
      if (!result.match) {
        setProgress(null);
        setProblem((e as Error).message);
        return;
      }
    }
    setProgress(null);
    if (result.match) {
      const was = settings.hubUrl.replace(/^https?:\/\//, '').replace(/:8766$/, '');
      if (normaliseAddress(result.match) !== settings.hubUrl
        && !(await confirm(`Use the laptop at ${result.match}?`, `Your laptop answered there with this phone's key. It was at ${was}.`, 'Use it'))) {
        return;
      }
      await updateSettings({ hubUrl: normaliseAddress(result.match), hubKey: result.key });
      setNote(`Found it at ${result.match}`);
      refreshStatus();
    } else if (!controller.signal.aborted) {
      setProblem(`Couldn't find your laptop on this Wi-Fi. Check it's on and ${APP_NAME} is running there, or disconnect and type its address.`);
    }
  };

  return (
    <>
      <Row
        title="Laptop's address"
        description={progress !== null ? `Looking on your Wi-Fi… ${Math.round(progress * 100)}%` : note ?? settings.hubUrl.replace(/^https?:\/\//, '').replace(/:8766$/, '')}
        left={(p) => <List.Icon {...p} icon="ip-network-outline" />}
        right={(p) => (progress !== null
          ? <Button mode="contained-tonal" compact style={p.style} onPress={() => { cancel.current?.abort(); setProgress(null); }}>Cancel</Button>
          : <Button mode="contained-tonal" compact style={p.style} onPress={findAgain}>Find again</Button>)}
      />
      {problem && <Text variant="bodySmall" style={[styles.refindProblem, { color: theme.colors.error }]}>{problem}</Text>}
    </>
  );
}

/** Phone: connect to the laptop hub, or show the connection. */
function ConnectLaptop() {
  const theme = useTheme();
  const { settings, updateSettings, hub, syncNow, refreshStatus } = useStore();
  const [address, setAddress] = useState(settings.hubUrl.replace(/^https?:\/\//, '').replace(/:8766$/, ''));
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [search, setSearch] = useState<{ progress: number; found: string[]; done: boolean } | null>(null);
  const cancelSearch = useRef<AbortController | null>(null);
  useEffect(() => () => cancelSearch.current?.abort(), []);

  if (settings.hubUrl && settings.hubKey) {
    return (
      <View>
        <Row
          title={hub.connected ? `Connected to ${hub.name ?? 'your laptop'}` : 'Laptop not reachable'}
          description={hub.connected
            ? (hub.syncing ? 'Syncing…' : hub.lastSync ? `Synced ${formatWhen(hub.lastSync)}` : 'Ready to sync')
            : `${hub.problem ?? ''} It works on its own until you're home.`.trim()}
          left={(p) => (
            <Lead style={p.style}>
              <View style={[styles.statusDot, { backgroundColor: hub.connected ? STATUS_COLOURS.ready : STATUS_COLOURS.checking }]} />
            </Lead>
          )}
          right={(p) => (
            <Button mode="contained-tonal" compact style={p.style} onPress={() => (hub.connected ? syncNow() : refreshStatus())}>
              {hub.connected ? 'Sync' : 'Retry'}
            </Button>
          )}
        />
        {!hub.connected && (
          <>
            <Divider />
            <LaptopAddress />
          </>
        )}
        <Divider />
        <Row
          title="Use the laptop's AI at home"
          description="Better answers and a cooler phone when the laptop is reachable"
          left={(p) => <List.Icon {...p} icon="laptop" />}
          right={(p) => <Switch style={p.style} value={settings.useLaptop} onValueChange={(v) => updateSettings({ useLaptop: v })} />}
        />
        <Divider />
        <Row
          title="Disconnect"
          titleStyle={{ color: theme.colors.error }}
          left={(p) => <List.Icon {...p} icon="link-off" color={theme.colors.error} />}
          onPress={() => updateSettings({ hubUrl: '', hubKey: '' })}
        />
      </View>
    );
  }

  const connect = async () => {
    setProblem(null);
    setBusy(true);
    const base = normaliseAddress(address);
    try {
      const { key } = await pairWith(base, code); // the code itself never crosses the network
      await updateSettings({ hubUrl: base, hubKey: key });
    } catch (e) {
      const message = (e as Error).message;
      setProblem(message === UNREACHABLE ? `${message} Check the address, and that the phone and laptop are on the same Wi-Fi.` : message);
    } finally {
      setBusy(false);
    }
  };

  const find = async () => {
    setProblem(null);
    const controller = new AbortController();
    cancelSearch.current = controller;
    setSearch({ progress: 0, found: [], done: false });
    try {
      const found = await findLaptops(
        (a) => {
          setSearch((s) => (s ? { ...s, found: [...s.found, a] } : s));
          setAddress((current) => current || a); // fill in the first one found
        },
        (progress) => setSearch((s) => (s ? { ...s, progress } : s)),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setSearch((s) => (s ? { ...s, done: true } : s));
      if (!found.length) {
        setProblem(`No laptop found. Check it's on and ${APP_NAME} is running there, then try again. `
          + "If it still isn't found, the laptop's firewall may be blocking Python (on Windows, allow it on private networks), or type the address.");
      }
    } catch (e) {
      setSearch(null);
      setProblem((e as Error).message);
    }
  };

  const searching = !!search && !search.done;

  return (
    <View style={styles.pad}>
      <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
        On the laptop, open {APP_NAME} → Settings → Home to see its code. Both need to be on the same Wi-Fi.
      </Text>
      <ScanPair />
      <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>Or type its address and code:</Text>
      {searching ? (
        <View style={styles.finding}>
          <View style={styles.rowBetween}>
            <Text variant="bodyMedium">Looking on your Wi-Fi… {Math.round(search.progress * 100)}%</Text>
            <Button compact onPress={() => { cancelSearch.current?.abort(); setSearch(null); }}>Cancel</Button>
          </View>
          <ProgressBar progress={search.progress} style={styles.findBar} />
        </View>
      ) : (
        <Button mode="contained-tonal" icon="laptop" onPress={find} style={styles.leftButton}>Find my laptop</Button>
      )}
      {!!search?.found.length && (
        <View style={styles.foundRow}>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {search.found.length === 1 ? 'Found:' : 'Found these. Tap yours:'}
          </Text>
          {search.found.map((a) => (
            <Chip key={a} icon={address === a ? 'check' : 'laptop'} selected={address === a} onPress={() => setAddress(a)} compact>{a}</Chip>
          ))}
        </View>
      )}
      <Field mode="outlined" dense label="Laptop address" placeholder="e.g. 192.168.1.20" value={address} onChangeText={setAddress} keyboardType="numbers-and-punctuation" autoCapitalize="none" />
      <Field mode="outlined" dense label="Code" value={code} onChangeText={setCode} autoCapitalize="characters" maxLength={12} />
      {problem && <Text variant="bodySmall" style={{ color: theme.colors.error }}>{problem}</Text>}
      <Button mode="contained-tonal" onPress={connect} loading={busy} disabled={busy || !address.trim() || !isPairingCode(cleanCode(code))}>
        {busy ? 'Pairing…' : 'Connect'}
      </Button>
    </View>
  );
}

/** Phone: automatic encrypted backups, and restoring one. These rows open the "Your data" card. */
function Backups({ onToast }: { onToast: (message: string) => void }) {
  const theme = useTheme();
  const { snapshot, restore } = useStore();
  const [status, setStatus] = useState<BackupStatus>({ on: false });
  const [mode, setMode] = useState<null | 'setup' | 'restore'>(null);
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = () => { backupStatus().then(setStatus).catch(() => undefined); };
  useEffect(refresh, []);

  const close = () => {
    setMode(null);
    setPass('');
    setAgain('');
    setFile(null);
    setProblem(null);
  };
  // Making the key from a passphrase takes a few seconds; let the button show it's working first.
  const nextFrame = () => new Promise((r) => setTimeout(r, 60));

  const setUp = async () => {
    if (pass.length < 8) return setProblem('Use at least 8 characters.');
    if (pass !== again) return setProblem("The passphrases don't match.");
    setProblem(null);
    setBusy(true);
    try {
      await nextFrame();
      const s = await setUpBackups(pass, snapshot());
      setStatus(s);
      close();
      onToast(`Backed up to ${s.folder}`);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const backUpNow = async () => {
    setBusy(true);
    try {
      await backUp(snapshot(), true);
      onToast('Backed up');
    } catch (e) {
      onToast((e as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const turnOff = async () => {
    if (await confirm('Turn off automatic backups?', 'Backups already saved stay in their folder.', 'Turn off')) {
      await turnOffBackups();
      refresh();
    }
  };

  const chooseBackup = async () => {
    close();
    const picked = await pickBackupFile();
    if (!picked) return;
    setFile(picked);
    setMode('restore');
  };

  const restoreIt = async () => {
    if (!file) return;
    setProblem(null);
    setBusy(true);
    try {
      await nextFrame();
      const summary = await restore(await openBackup(file.text, pass));
      close();
      onToast(summary);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const muted = { color: theme.colors.onSurfaceVariant };
  return (
    <>
      <Row
        title="Automatic backups"
        description={status.on
          ? status.problem ?? `Daily to ${status.folder}, encrypted`
          : 'Saves an encrypted copy of your memory and notes each day, to a folder you choose'}
        descriptionStyle={status.problem ? { color: theme.colors.error } : undefined}
        left={(p) => <List.Icon {...p} icon="shield-lock-outline" />}
        right={(p) => (
          <Switch
            style={p.style}
            value={status.on || mode === 'setup'}
            disabled={busy}
            onValueChange={(v) => (v ? (close(), setMode('setup')) : mode === 'setup' ? close() : turnOff())}
          />
        )}
      />
      {mode === 'setup' && (
        <View style={styles.pad}>
          <Text variant="bodyMedium" style={muted}>
            Choose a passphrase, then the folder to save backups in. You'll need the passphrase to restore a backup, on this
            phone or a new one. It can't be recovered if you forget it.
          </Text>
          <Field dense label="Passphrase" value={pass} onChangeText={setPass} secureTextEntry autoCapitalize="none" autoCorrect={false} autoFocus />
          <Field dense label="Passphrase again" value={again} onChangeText={setAgain} secureTextEntry autoCapitalize="none" autoCorrect={false} />
          {problem && <Text variant="bodySmall" style={{ color: theme.colors.error }}>{problem}</Text>}
          <View style={styles.formButtons}>
            <Button onPress={close} disabled={busy}>Cancel</Button>
            <Button mode="contained" onPress={setUp} loading={busy} disabled={busy || !pass || !again}>Choose folder</Button>
          </View>
        </View>
      )}
      {status.on && (
        <>
          <Divider />
          <Row
            title="Back up now"
            description={status.last ? `Last backup ${formatWhen(status.last)}` : 'Not backed up yet'}
            left={(p) => <List.Icon {...p} icon="content-save-outline" />}
            right={(p) => (
              <Button mode="contained-tonal" compact style={p.style} onPress={backUpNow} disabled={busy}>Back up</Button>
            )}
          />
        </>
      )}
      <Divider />
      <Row
        title="Restore an encrypted backup"
        description="Adds anything new from a backup file; nothing is overwritten"
        left={(p) => <List.Icon {...p} icon="backup-restore" />}
        onPress={chooseBackup}
        disabled={busy}
      />
      {mode === 'restore' && file && (
        <View style={styles.pad}>
          <Text variant="bodyMedium" style={muted}>Enter the passphrase for {file.name}.</Text>
          {/* Focusing it opens the keyboard and scrolls the form into view, so it can't open out of sight. */}
          <Field dense label="Passphrase" value={pass} onChangeText={setPass} secureTextEntry autoCapitalize="none" autoCorrect={false} autoFocus />
          {problem && <Text variant="bodySmall" style={{ color: theme.colors.error }}>{problem}</Text>}
          <View style={styles.formButtons}>
            <Button onPress={close} disabled={busy}>Cancel</Button>
            <Button mode="contained" onPress={restoreIt} loading={busy} disabled={busy || !pass}>Restore</Button>
          </View>
        </View>
      )}
      <Divider />
    </>
  );
}

const SAME_AS_PHONE = 'Same as the phone';

/** Phone: the language for talking and reading aloud, from the phone's installed offline speech packs. */
function VoiceLanguage() {
  const { settings, updateSettings } = useStore();
  const [languages, setLanguages] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useBackCloses(open, close);
  useEffect(() => {
    offlineLanguages().then(setLanguages);
  }, []);
  const choose = (language: string) => {
    setOpen(false);
    updateSettings({ voiceLang: language });
  };
  const current = settings.voiceLang ? languageName(settings.voiceLang) : `${SAME_AS_PHONE}: ${languageName(deviceLanguage())}`;
  return (
    <Row
      title="Voice language"
      description={languages && !languages.length
        ? "This phone has no offline speech packs yet. Add one in its voice input settings."
        : `${current}. Used when you talk and when answers are read aloud.`}
      left={(p) => <List.Icon {...p} icon="translate" />}
      right={(p) => (
        <View style={p.style}>
          <Menu
            visible={open}
            onDismiss={close}
            anchorPosition="bottom"
            anchor={<Button mode="contained-tonal" compact disabled={!languages?.length} onPress={() => setOpen(true)}>Change</Button>}
          >
            <Menu.Item title={SAME_AS_PHONE} trailingIcon={settings.voiceLang ? undefined : 'check'} onPress={() => choose('')} />
            {(languages ?? []).map((l) => (
              <Menu.Item key={l} title={languageName(l)} trailingIcon={settings.voiceLang === l ? 'check' : undefined} onPress={() => choose(l)} />
            ))}
          </Menu>
        </View>
      )}
    />
  );
}

/** Phone: add the home-screen widget. The home screen asks first, so nothing is added without a yes there. */
function WidgetRow({ onToast }: { onToast: (message: string) => void }) {
  return (
    <Row
      title="Home-screen widget"
      description="Ask, or start talking hands-free, in one tap."
      left={(p) => <List.Icon {...p} icon="widgets-outline" />}
      right={(p) => (
        <Button
          mode="contained-tonal" compact style={p.style}
          onPress={async () => {
            if (!(await addWidget().catch(() => false))) {
              onToast("Your home screen can't add it from here. Touch and hold the home screen, tap Widgets, then find Aislet.");
            }
          }}
        >
          Add
        </Button>
      )}
    />
  );
}

/** Exactly what goes online, and what never does. Keep this true: check it whenever something new uses the network. */
const PRIVACY = Platform.OS === 'web'
  ? [
    { icon: 'shield-lock-outline', title: 'What you say stays here', text: 'Chats, memory, notes and files stay on this computer and your paired phone. The AI runs on this computer.' },
    { icon: 'download-outline', title: 'Online only for downloads', text: 'The installer downloads the app, and Ollama downloads the AI models.' },
    { icon: 'web', title: 'Web search only if you switch it on', text: 'With Search the web on (Settings → AI), this computer sends only the search words to DuckDuckGo. It is off until you turn it on.' },
    { icon: 'lan', title: 'Your phone talks to it directly', text: 'Over your home Wi-Fi, never through the internet, and encrypted with a key made from your pairing code.' },
    { icon: 'account-off-outline', title: 'No account, no tracking', text: 'No sign-in, no analytics and no ads.' },
  ]
  : [
    { icon: 'shield-lock-outline', title: 'What you say stays on your devices', text: 'Chats, memory, notes, photos and voice are handled on this phone, or on your laptop over your own Wi-Fi.' },
    { icon: 'download-outline', title: 'Online only for downloads', text: 'AI models download from Hugging Face when you tap Download or Get. Libraries are files you add yourself.' },
    { icon: 'web', title: 'Web search only if you switch it on', text: 'With Search the web on (Settings → AI), this phone sends only the search words to DuckDuckGo. It is off until you turn it on.' },
    { icon: 'lan', title: 'Your laptop, directly', text: 'Phone and laptop talk over your home Wi-Fi, never through the internet, encrypted with a key made from your pairing code.' },
    { icon: 'account-off-outline', title: 'No account, no tracking', text: "No sign-in, no analytics, no ads. Android's cloud backup and phone-to-phone copying are off; backups go only to the folder you choose." },
  ];

function Privacy() {
  return (
    <>
      {PRIVACY.map((p) => (
        <View key={p.icon}>
          <Row title={p.title} description={p.text} left={(l) => <List.Icon {...l} icon={p.icon} />} />
          <Divider />
        </View>
      ))}
      <Row
        title="How it's checked"
        description="The security model, and the tests that attack the laptop hub"
        left={(l) => <List.Icon {...l} icon="check-decagram-outline" />}
        right={(r) => <List.Icon {...r} icon="open-in-new" />}
        onPress={() => Linking.openURL('https://github.com/latczar/aislet/blob/main/docs/DEVELOPMENT.md#security-model')}
      />
    </>
  );
}

export function SettingsView({ inBar }: { inBar?: boolean }) {
  const theme = useTheme();
  const { settings, updateSettings, status, refreshStatus, exportData, importData, clearChats, chats, memories, notes, hub, libraries } = useStore();
  const [allModels, setAllModels] = useState(false);
  const [more, setMore] = useState(false); // everyday settings first; the rest behind "More settings"
  const [name, setName] = useState(settings.name);
  const [instructions, setInstructions] = useState(settings.instructions);
  // Leaving Settings (Back, or the menu) while typing doesn't blur the box, so save what was typed on the way out.
  const typed = useRef({ name, instructions, settings });
  typed.current = { name, instructions, settings };
  useEffect(() => () => {
    const t = typed.current;
    if (t.name.trim() !== t.settings.name || t.instructions.trim() !== t.settings.instructions) {
      updateSettings({ name: t.name.trim(), instructions: t.instructions.trim() });
    }
  }, [updateSettings]);
  const [toast, setToast] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const changed = () => {
    setTick((t) => t + 1);
    refreshStatus();
  };
  const initials = (settings.name || '?').trim().slice(0, 1).toUpperCase();

  return (
    <View style={styles.flex}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <PageTitle inBar={inBar}>Settings</PageTitle>

        <Section title="You">
          <View style={styles.profile}>
            <Avatar.Text size={48} label={initials} style={{ backgroundColor: theme.colors.primaryContainer }} color={theme.colors.onPrimaryContainer} />
            <Field
              mode="outlined"
              label="Your name"
              value={name}
              onChangeText={setName}
              onBlur={() => updateSettings({ name: name.trim() })}
              onSubmitEditing={() => updateSettings({ name: name.trim() })}
              style={styles.flex}
              dense
            />
          </View>
        </Section>

        <Section title="AI">
          <Row
            title={status?.label ?? 'Checking…'}
            description={status?.ready ? `Ready${status.model ? ` · ${status.model}` : ''}. Works with no internet.` : status?.problem}
            left={(p) => (
              <Lead style={p.style}>
                <View style={[styles.statusDot, { backgroundColor: !status || status.starting ? STATUS_COLOURS.checking : status.ready ? STATUS_COLOURS.ready : STATUS_COLOURS.problem }]} />
              </Lead>
            )}
            right={(p) => <Button mode="contained-tonal" compact style={p.style} onPress={refreshStatus}>Check</Button>}
          />
          <Divider />
          <Row
            title="Search the web"
            description={settings.webSearch
              ? 'For questions that need current information, or when you tap the globe. Only the search words go to DuckDuckGo.'
              : 'Off: answers come from the AI, your notes and your libraries only.'}
            left={(p) => <List.Icon {...p} icon="web" />}
            right={(p) => <Switch style={p.style} value={settings.webSearch} onValueChange={(v) => updateSettings({ webSearch: v })} />}
          />
          {engine.models && (
            <>
              <Divider />
              <RadioButton.Group value={settings.modelId} onValueChange={(id) => updateSettings({ modelId: id })}>
                {/* The model that suits this phone (listed first) and any you have; the rest wait behind "Other models".
                    Models no longer offered show only while they're on the phone. */}
                {shownModels(engine.models, settings.modelId, allModels)
                  .map((m) => (
                    <ModelRow
                      key={m.id} model={m} selected={settings.modelId === m.id} onSelect={() => updateSettings({ modelId: m.id })} onChanged={changed}
                      replaces={[
                        ...engine.models!.chatModels().filter((o) => o.downloaded && o.id !== m.id),
                        ...[engine.models!.visionModel()].filter((v) => v.downloaded && v.forModel && v.forModel !== m.id),
                      ]}
                    />
                  ))}
              </RadioButton.Group>
              {more && !allModels && shownModels(engine.models, settings.modelId, true).length > shownModels(engine.models, settings.modelId, false).length && (
                <>
                  <Divider />
                  <Row
                    title="Other models"
                    description="Smaller or older models, if this one doesn't suit your phone. Getting one replaces the current model."
                    left={(p) => <List.Icon {...p} icon="view-list-outline" />}
                    right={(p) => <List.Icon {...p} icon="chevron-down" />}
                    onPress={() => setAllModels(true)}
                  />
                </>
              )}
              {more && (
                <>
                  <Divider />
                  <ModelRow model={engine.models.searchModel()} onChanged={changed} />
                  <Divider />
                  <ModelRow model={engine.models.visionModel()} onChanged={changed} icon="image-search-outline" />
                </>
              )}
            </>
          )}
        </Section>

        <Section title="How it answers" footer={more ? 'Instructions apply to every chat, on top of what it remembers about you.' : undefined}>
          <View style={styles.pad}>
            <Text variant="labelLarge" style={styles.label}>Answer length</Text>
            <SegmentedButtons
              value={settings.length}
              onValueChange={(v) => updateSettings({ length: v as AnswerLength })}
              buttons={[
                { value: 'short', label: 'Short' },
                { value: 'balanced', label: 'Balanced' },
                { value: 'detailed', label: 'Detailed' },
              ]}
            />
            {more && (
            <Field
              mode="outlined"
              label="Custom instructions"
              placeholder="e.g. Be direct. Explain code step by step. Use metric units."
              value={instructions}
              onChangeText={setInstructions}
              onBlur={() => updateSettings({ instructions: instructions.trim() })}
              multiline
              style={styles.instructions}
            />
            )}
          </View>
        </Section>

        <Section
          title="Home"
          footer={Platform.OS === 'web'
            ? 'Your phone syncs chats, memory and notes with this laptop over home Wi-Fi, and can use its bigger AI.'
            : 'At home, chats, memory and notes sync with your laptop, and the phone can use its bigger AI. Photos stay on the phone.'}
        >
          {Platform.OS === 'web' ? <PairPhone /> : <ConnectLaptop />}
        </Section>

        {libraries.supported && (
          <Section title="Libraries" footer="When a library is used, the answer says which file or article it came from. Aislet only reads your own files: it never changes, moves or deletes them.">
            <Libraries onToast={setToast} />
          </Section>
        )}

        <Section title="Appearance">
          <View style={styles.pad}>
            <SegmentedButtons
              value={settings.appearance}
              onValueChange={(v) => updateSettings({ appearance: v as Appearance })}
              buttons={[
                { value: 'light', label: 'Light', icon: 'white-balance-sunny' },
                { value: 'dark', label: 'Dark', icon: 'weather-night' },
                { value: 'system', label: Platform.OS === 'web' ? 'Match system' : 'Match phone', icon: 'theme-light-dark' },
              ]}
            />
          </View>
          {more && Platform.OS !== 'web' && (
            <>
              <Divider />
              <Row
                title="Vibrate on taps"
                description="A light buzz when you tap buttons"
                left={(p) => <List.Icon {...p} icon="vibrate" />}
                right={(p) => <Switch style={p.style} value={settings.haptics} onValueChange={(v) => updateSettings({ haptics: v })} />}
              />
            </>
          )}
        </Section>

        <Surface style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant }]} elevation={0}>
          <Row
            title={more ? 'Fewer settings' : 'More settings'}
            description={more ? undefined : Platform.OS === 'web'
              ? 'Your own instructions, speed, keyboard shortcuts, export and privacy'
              : 'Your own instructions, voice, speed and heat, backups, privacy and other models'}
            left={(p) => <List.Icon {...p} icon="tune-variant" />}
            right={(p) => <List.Icon {...p} icon={more ? 'chevron-up' : 'chevron-down'} />}
            onPress={() => setMore((m) => !m)}
          />
        </Surface>

        {more && (
          <>
            <Section title="Memory">
              <Row
                title="Learn from my chats"
                description="Saves lasting facts and preferences as you talk"
                left={(p) => <List.Icon {...p} icon="lightbulb-on-outline" />}
                right={(p) => <Switch style={p.style} value={settings.learn} onValueChange={(v) => updateSettings({ learn: v })} />}
              />
              <Divider />
              <Row
                title="Look back at earlier chats"
                description={'When you ask "what did we say about…", it searches your earlier chats on this device'}
                left={(p) => <List.Icon {...p} icon="history" />}
                right={(p) => <Switch style={p.style} value={settings.recallChats !== false} onValueChange={(v) => updateSettings({ recallChats: v })} />}
              />
            </Section>

          {voiceSupported && (
            <Section
              title="Voice"
              footer="Talking uses your phone's offline speech recognition, so it works without the internet. To add a language, download its offline pack in the phone's voice input settings."
            >
              <VoiceLanguage />
            </Section>
          )}

          {widgetSupported && (
            <Section title="Widget">
              <WidgetRow onToast={setToast} />
            </Section>
          )}

          <Section
            title="Speed and heat"
            footer={[
              settings.performance === 'cool'
                ? 'Cool: slower replies, least heat and battery. The model loads only when you send.'
                : settings.performance === 'max'
                  ? 'Max: quickest with long questions and files. Uses more cores and keeps the model ready, so it runs warmer.'
                  : 'Balanced: quick replies without working the device too hard.',
              engine.lastSpeed?.() ? `Last reply: ${engine.lastSpeed()!.toFixed(1)} tokens a second.` : '',
            ].filter(Boolean).join(' ')}
          >
            <View style={styles.pad}>
              <Text variant="labelLarge">Performance</Text>
              <SegmentedButtons
                value={settings.performance}
                onValueChange={(v) => updateSettings({ performance: v as Performance })}
                buttons={[
                  { value: 'cool', label: 'Cool', icon: 'snowflake' },
                  { value: 'balanced', label: 'Balanced', icon: 'scale-balance' },
                  { value: 'max', label: 'Max', icon: 'lightning-bolt' },
                ]}
              />
            </View>
          </Section>

          {Platform.OS === 'web' && (
            <Section title="Keyboard shortcuts">
              {SHORTCUTS.map((s, i) => (
                <View key={s.label}>
                  {i > 0 && <Divider />}
                  <Row
                    title={s.label}
                    right={(p) => <Text variant="labelLarge" style={[p.style, styles.keys, { color: theme.colors.onSurfaceVariant }]}>{s.keys}</Text>}
                  />
                </View>
              ))}
            </Section>
          )}

          <Section
            title="Your data"
            footer={backupSupported
              ? 'Backups and exports hold your memory and notes; chats stay where they are. Export makes a plain file to bring them to your other device.'
              : 'Export makes a file with your memory and notes. Import it on your other device to bring them over. Chats stay where they are.'}
          >
            {backupSupported && <Backups onToast={setToast} />}
            <Row
              title="Export memory and notes"
              description={`${memories.length} facts · ${notes.length} notes`}
              left={(p) => <List.Icon {...p} icon="export-variant" />}
              onPress={() => exportData().catch((e) => setToast((e as Error).message))}
            />
            <Divider />
            <Row
              title="Import from a backup"
              description="Adds anything new; nothing is overwritten"
              left={(p) => <List.Icon {...p} icon="import" />}
              onPress={async () => {
                try {
                  const summary = await importData();
                  if (summary) setToast(summary);
                } catch (e) {
                  setToast((e as Error).message);
                }
              }}
            />
            <Divider />
            <Row
              title="Delete all chats"
              titleStyle={{ color: theme.colors.error }}
              description={`${chats.length} ${chats.length === 1 ? 'chat' : 'chats'}. Memory and notes are kept.`}
              left={(p) => <List.Icon {...p} icon="trash-can-outline" color={theme.colors.error} />}
              disabled={!chats.length}
              onPress={async () => {
                if (await confirm('Delete all chats?', "This can't be undone. Your memory and notes stay.")) clearChats();
              }}
            />
          </Section>

          <Section
            title="Privacy"
            footer={Platform.OS === 'web'
              ? 'Try it with this computer offline: everything except downloads still works.'
              : 'Try it with Wi-Fi and mobile data off: everything except downloads still works.'}
          >
            <Privacy />
          </Section>

          {engine.models && (
            <Section title="Advanced">
              {(
                <>
                  <View style={styles.pad}>
                    <Text variant="labelLarge">Runs on</Text>
                    <SegmentedButtons
                      value={settings.accel}
                      onValueChange={(v) => updateSettings({ accel: v as Accel })}
                      buttons={[
                        { value: 'cpu', label: 'CPU' },
                        { value: 'gpu', label: 'GPU' },
                        { value: 'npu', label: 'AI chip' },
                      ]}
                    />
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      CPU works on every phone. The others can be quicker or cooler on some phones; if one doesn't work, the phone uses the CPU instead.
                    </Text>
                  </View>
                  {!!settings.hubUrl && !!settings.hubKey && hub.connected && (
                    <>
                      <Divider />
                      <LaptopAddress />
                    </>
                  )}
                </>
              )}
            </Section>
          )}

          </>
        )}

        <Text variant="bodySmall" style={[styles.about, { color: theme.colors.onSurfaceVariant }]}>
          {engine.where === 'laptop'
            ? `${APP_NAME} runs on this laptop through Ollama. Your data stays on your own devices.`
            : `${APP_NAME} runs on this phone, and on your laptop when you're home. Your data stays on your own devices; the internet is only used to download models.`}
          {'\n\n'}
          <Text
            variant="bodySmall"
            style={{ color: theme.colors.tertiary }}
            onPress={() => Linking.openURL('https://github.com/latczar/aislet/blob/main/THIRD_PARTY_LICENSES.md')}
          >
            Open-source licences
          </Text>
        </Text>
      </ScrollView>
      <Snackbar visible={!!toast} onDismiss={() => setToast(null)} duration={3000}>{toast}</Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { padding: 20, paddingBottom: 32, gap: 6, width: '100%', maxWidth: 720, alignSelf: 'center' },
  h1: { fontFamily: FONT.semibold, marginBottom: 8 },
  section: { gap: 8, marginTop: 10 },
  sectionTitle: { paddingHorizontal: 4 },
  card: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  footer: { paddingHorizontal: 4, lineHeight: 18 },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16 },
  pad: { padding: 16, gap: 12 },
  label: {},
  instructions: { minHeight: 96 },
  iconAction: { margin: 0 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  keys: { fontFamily: FONT.medium },
  finding: { gap: 6 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  findBar: { height: 4, borderRadius: 2 },
  foundRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  leftButton: { alignSelf: 'flex-start' },
  formButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  refindProblem: { paddingHorizontal: 16, paddingBottom: 10 },
  pairTop: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 20 },
  pairText: { flex: 1, minWidth: 220, gap: 8 },
  pairGrid: { gap: 6 },
  pairRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  pairLabel: { width: 64 },
  mono: { fontFamily: Platform.select({ web: 'ui-monospace, Consolas, monospace', android: 'monospace', default: 'Menlo' }), flexShrink: 1 },
  textButtonFlush: { marginLeft: -12 }, // lines a text button's label up with the text above it
  progress: { paddingHorizontal: 16, paddingBottom: 12, gap: 6 },
  bar: { height: 6, borderRadius: 3 },
  about: { marginTop: 16, lineHeight: 18, paddingHorizontal: 4 },
});
