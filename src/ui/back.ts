// Android's Back button closes an open menu and stays in the app. Paper's Menu closes itself on Back but lets the
// press carry on, which also sends the app to the background.
import { useEffect } from 'react';
import { BackHandler } from 'react-native';

export function useBackCloses(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [open, close]);
}
