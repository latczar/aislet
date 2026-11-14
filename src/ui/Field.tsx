// An outlined text box. Paper fills outlined boxes with the page colour, which looks muddy on a white
// card; this one is always white (or the dark theme's surface), wherever it sits.
import React from 'react';
import { TextInput, useTheme } from 'react-native-paper';

type FieldProps = React.ComponentProps<typeof TextInput>;

export function Field({ style, ...props }: FieldProps) {
  const theme = useTheme();
  return <TextInput mode="outlined" {...props} style={[{ backgroundColor: theme.colors.surface }, style]} />;
}
