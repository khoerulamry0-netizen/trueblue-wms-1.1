import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { id, type TranslationKey } from './locales/id';
import { en } from './locales/en';
import { applyDomLanguage } from './domAutoTranslate';

export type Language = 'id' | 'en';

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  toggleLanguage: () => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  formatRemainingEd: (months: number, days: number) => string;
}

const STORAGE_KEY = 'trueblue_wms_language';

const dictionaries: Record<Language, Record<TranslationKey, string>> = {
  id,
  en,
};

const LanguageContext = createContext<LanguageContextType | null>(null);

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'en' || saved === 'id') return saved;
    } catch {
      // Ignore localStorage errors
    }
    return 'id';
  });

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    try {
      localStorage.setItem(STORAGE_KEY, lang);
      document.documentElement.lang = lang;
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  const toggleLanguage = useCallback(() => {
    setLanguage(language === 'id' ? 'en' : 'id');
  }, [language, setLanguage]);

  useEffect(() => {
    document.documentElement.lang = language;
    if (typeof document === 'undefined' || !document.body) return;
    let rafId: number | null = null;
    let applying = false;
    const run = () => {
      if (applying) return;
      applying = true;
      try {
        applyDomLanguage(language, document.body);
      } finally {
        applying = false;
      }
    };
    run();
    const t1 = window.setTimeout(run, 80);
    const t2 = window.setTimeout(run, 300);
    if (language !== 'en' || typeof MutationObserver === 'undefined') {
      return () => {
        window.clearTimeout(t1);
        window.clearTimeout(t2);
      };
    }
    const observer = new MutationObserver(() => {
      if (applying || rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        run();
      });
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['placeholder', 'title', 'aria-label']
    });
    return () => {
      observer.disconnect();
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [language]);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>): string => {
      const dict = dictionaries[language] || dictionaries.id;
      let text = dict[key] || dictionaries.id[key] || key;

      if (params) {
        Object.entries(params).forEach(([paramKey, val]) => {
          text = text.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(val));
        });
      }

      return text;
    },
    [language]
  );

  const formatRemainingEd = useCallback(
    (months: number, days: number): string => {
      const mUnit = language === 'en' ? 'mos' : 'bln';
      const dUnit = language === 'en' ? (days === 1 ? 'day' : 'days') : 'hari';

      if (months > 0 && days > 0) {
        return `${months} ${mUnit} ${days} ${dUnit}`;
      } else if (months > 0) {
        return `${months} ${mUnit}`;
      } else {
        return `${days} ${dUnit}`;
      }
    },
    [language]
  );

  return (
    <LanguageContext.Provider value={{ language, setLanguage, toggleLanguage, t, formatRemainingEd }}>
      {children}
    </LanguageContext.Provider>
  );
};

export function useLanguage(): LanguageContextType {
  const context = useContext(LanguageContext);
  if (!context) {
    // Fallback safe dummy context if used outside provider
    return {
      language: 'id',
      setLanguage: () => {},
      toggleLanguage: () => {},
      t: (key: TranslationKey, params?: Record<string, string | number>) => {
        let text = id[key] || key;
        if (params) {
          Object.entries(params).forEach(([paramKey, val]) => {
            text = text.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(val));
          });
        }
        return text;
      },
      formatRemainingEd: (m: number, d: number) => {
        if (m > 0 && d > 0) return `${m} bln ${d} hari`;
        if (m > 0) return `${m} bln`;
        return `${d} hari`;
      },
    };
  }
  return context;
}
