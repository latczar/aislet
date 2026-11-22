// A page's title, with the phone's menu button beside it (Memory, Notes and Settings), so there's no second title bar.
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { FONT } from './theme';

export function PageTitle({ children, menu }: { children: string; menu?: React.ReactNode }) {
  return (
    <View style={[styles.row, menu ? styles.withMenu : null]}>
      {menu}
      <Text variant="headlineSmall" style={styles.title}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  withMenu: { marginLeft: -14, gap: 2 }, // the icon lines up with the page's left edge
  title: { fontFamily: FONT.semibold },
});
