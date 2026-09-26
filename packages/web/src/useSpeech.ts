import { useCallback, useRef } from 'react';

interface Options {
  lang?: string;
  onEnd?: () => void;
}

export function useSpeech({ lang = 'en', onEnd }: Options = {}) {
  const hasApi = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  const speak = useCallback(
    (text: string, chain = false) => {
      if (!hasApi) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices();
      const voice = voices.find((v) => v.lang.startsWith(lang));
      if (voice) u.voice = voice;
      u.rate = 1.02;
      u.onend = () => {
        if (chain) onEndRef.current?.();
      };
      window.speechSynthesis.speak(u);
    },
    [hasApi, lang]
  );

  const cancel = useCallback(() => {
    if (hasApi) window.speechSynthesis.cancel();
  }, [hasApi]);

  return { speak, cancel, hasApi };
}
