import React, { createContext, useContext, useMemo } from 'react';
import { t as translate, type Lang } from '../i18n';

/**
 * 界面语言走 **context**，不走模块级全局变量。
 *
 * 模块级 `let currentLang` 看起来更省事（`t('x')` 不用先拿 hook），但它不是 React 的依赖：
 * 改了语言之后，只有恰好因为别的原因重渲染的组件才会跟着变，其余的停在旧语言上，
 * 表现成「切了语言，一半界面没动，点一下才变」。语言是**渲染输入**，就得让 React 知道。
 *
 * 语言本身存在 `Settings` 里（`kirolex-settings`），所以持久化和「改了立刻生效」都是现成的：
 * App 把 `settings.language` 喂进这个 Provider，settings 一变整棵树重渲染。
 */
const LangContext = createContext<Lang>('zh');

export const LangProvider: React.FC<{ lang: Lang; children: React.ReactNode }> = ({ lang, children }) => (
  <LangContext.Provider value={lang}>{children}</LangContext.Provider>
);

/** 当前语言。需要按语言分支（而不只是取文案）时用它。 */
export function useLang(): Lang {
  return useContext(LangContext);
}

/**
 * 取文案的函数。身份随语言变化 —— 这是**故意的**：它进了 `useMemo`/`useCallback` 的依赖清单之后，
 * 语言一变，那些缓存下来的 JSX 和回调也跟着重算，不会留下上一种语言的残留。
 */
export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const lang = useContext(LangContext);
  return useMemo(() => (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang]);
}
