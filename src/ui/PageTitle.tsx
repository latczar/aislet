// A page's title. On the phone the title and the menu button (☰) sit in a fixed bar at the top instead (Shell), so the
// menu stays in reach on long pages; there the page leaves its own title out.
import React from 'react';
import { StyleSheet } from 'react-native';
import { Text } from 'react-native-paper';
import { FONT } from './theme';

export function PageTitle({ children, inBar }: { children: string; inBar?: boolean }) {
  if (inBar) return null;
  return <Text variant="headlineSmall" style={styles.title}>{children}</Text>;
}

const styles = StyleSheet.create({
  title: { fontFamily: FONT.semibold, marginBottom: 8 },
});
