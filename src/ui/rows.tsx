// List rows that line up. Every row in a card shares the same columns: a 24 dp leading slot (an icon,
// a status dot or a radio button), the text, then one trailing control centred on the row.
//
// Paper hands each left/right renderer a `style` that sets those margins and centres the control.
// Dropping it is what made buttons stretch to the full row height and titles start at different
// places, so always pass it on: `right={(p) => <Button style={p.style} … />}`.
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { List } from 'react-native-paper';
import { FONT } from './theme';

type RowProps = React.ComponentProps<typeof List.Item>;

/** A list row with the app's title weight and room for a three-line description. */
export function Row({ titleStyle, descriptionNumberOfLines = 3, ...props }: RowProps) {
  return <List.Item {...props} titleStyle={[styles.title, titleStyle]} descriptionNumberOfLines={descriptionNumberOfLines} />;
}

/** The leading slot for anything that isn't a List.Icon, sized and placed exactly like one. */
export function Lead({ style, children }: { style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  return <View style={[style, styles.lead]}>{children}</View>;
}

const styles = StyleSheet.create({
  title: { fontFamily: FONT.medium },
  lead: { width: 24, alignItems: 'center', justifyContent: 'center' },
});
