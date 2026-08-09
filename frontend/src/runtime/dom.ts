type PrimitiveChild = string | number | boolean | null | undefined;
export type DomChild = Node | PrimitiveChild | DomChild[];

type EffectHook = {
  kind: 'effect' | 'layout';
  deps?: readonly unknown[];
  next?: () => void | (() => void);
  cleanup?: () => void;
};

type StateHook<T = unknown> = { kind: 'state'; value: T };
type MemoHook<T = unknown> = { kind: 'memo'; deps?: readonly unknown[]; value: T };
type RefHook<T = unknown> = { kind: 'ref'; value: { current: T } };
type Hook = EffectHook | StateHook | MemoHook | RefHook;

type Component = (props: any) => DomChild;
type ComponentInstance = {
  hooks: Hook[];
  hookIndex: number;
  type: Component;
};

type DomRoot = {
  container: HTMLElement;
  renderView: () => DomChild;
  instances: Map<number, ComponentInstance>;
  componentCursor: number;
  elementCursor: number;
  scheduled: boolean;
  disposed: boolean;
};

type LazyComponent = {
  __nativeLazy: true;
  loader: () => Promise<{ default: Component }>;
  state: 'pending' | 'ready' | 'error';
  component?: Component;
  promise?: Promise<void>;
  error?: unknown;
  roots: Set<DomRoot>;
};

type CurrentRender = { root: DomRoot; instance: ComponentInstance };

const Fragment = Symbol('DomFragment');
const Suspense = Symbol('DomSuspense');
const StrictMode = Symbol('DomStrictMode');
const SVG_ELEMENTS = new Set(['svg', 'path', 'circle', 'line', 'rect', 'polyline', 'polygon', 'ellipse', 'g']);
let activeRoot: DomRoot | null = null;
let currentRender: CurrentRender | null = null;
type ElementEventState = {
  handlers: Map<string, EventListener>;
  registered: Set<string>;
};
const elementEventStates = new WeakMap<Element, ElementEventState>();
const elementRefs = new WeakMap<Element, unknown>();

function dependenciesChanged(previous?: readonly unknown[], next?: readonly unknown[]) {
  if (next === undefined) return true;
  if (!previous || previous.length !== next.length) return true;
  return previous.some((item, index) => !Object.is(item, next[index]));
}

function schedule(root: DomRoot) {
  if (root.scheduled || root.disposed) return;
  root.scheduled = true;
  queueMicrotask(() => {
    root.scheduled = false;
    renderRoot(root);
  });
}

function useHook<T extends Hook>(factory: () => T): T {
  if (!currentRender) throw new Error('Hook hanya dapat dipakai di dalam komponen DOM.');
  const { instance } = currentRender;
  const index = instance.hookIndex++;
  if (!instance.hooks[index]) instance.hooks[index] = factory();
  return instance.hooks[index] as T;
}

export function useState<T>(initial: T | (() => T)): [T, (value: T | ((current: T) => T)) => void] {
  if (!currentRender) throw new Error('useState hanya dapat dipakai di dalam komponen DOM.');
  const root = currentRender.root;
  const hook = useHook<StateHook<T>>(() => ({
    kind: 'state',
    value: typeof initial === 'function' ? (initial as () => T)() : initial
  }));
  const setValue = (next: T | ((current: T) => T)) => {
    const value = typeof next === 'function' ? (next as (current: T) => T)(hook.value) : next;
    if (Object.is(value, hook.value)) return;
    hook.value = value;
    schedule(root);
  };
  return [hook.value, setValue];
}

function registerEffect(kind: EffectHook['kind'], callback: () => void | (() => void), deps?: readonly unknown[]) {
  const hook = useHook<EffectHook>(() => ({ kind }));
  if (!dependenciesChanged(hook.deps, deps)) return;
  hook.deps = deps;
  hook.next = callback;
}

export function useEffect(callback: () => void | (() => void), deps?: readonly unknown[]) {
  registerEffect('effect', callback, deps);
}

export function useLayoutEffect(callback: () => void | (() => void), deps?: readonly unknown[]) {
  registerEffect('layout', callback, deps);
}

export function useMemo<T>(factory: () => T, deps?: readonly unknown[]): T {
  const hook = useHook<MemoHook<T>>(() => ({ kind: 'memo', deps, value: factory() }));
  if (dependenciesChanged(hook.deps, deps)) {
    hook.deps = deps;
    hook.value = factory();
  }
  return hook.value;
}

export function useRef<T>(initial: T): { current: T } {
  return useHook<RefHook<T>>(() => ({ kind: 'ref', value: { current: initial } })).value;
}

function asNode(value: DomChild): Node {
  if (value instanceof Node) return value;
  const fragment = document.createDocumentFragment();
  appendChild(fragment, value);
  return fragment;
}

function appendChild(parent: Node, value: DomChild) {
  if (value === null || value === undefined || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    value.forEach((child) => appendChild(parent, child));
    return;
  }
  parent.appendChild(value instanceof Node ? value : document.createTextNode(String(value)));
}

function cleanupInstance(instance: ComponentInstance) {
  instance.hooks.forEach((hook) => {
    if (hook.kind === 'effect' || hook.kind === 'layout') hook.cleanup?.();
  });
}

function renderComponent(type: Component, props: Record<string, unknown>): Node {
  if (!activeRoot) throw new Error('Komponen DOM dirender di luar root aplikasi.');
  const root = activeRoot;
  const index = root.componentCursor++;
  let instance = root.instances.get(index);
  if (!instance || instance.type !== type) {
    if (instance) cleanupInstance(instance);
    instance = { hooks: [], hookIndex: 0, type };
    root.instances.set(index, instance);
  }
  instance.hookIndex = 0;
  const previousRender = currentRender;
  currentRender = { root, instance };
  try {
    return asNode(type(props));
  } finally {
    currentRender = previousRender;
  }
}

export function forwardRef(render: (props: Record<string, unknown>, ref: unknown) => DomChild): Component {
  return (props) => render(props, props.ref);
}

export function memo(component: Component): Component {
  return component;
}

export function lazy(loader: () => Promise<{ default: Component }>): LazyComponent {
  return { __nativeLazy: true, loader, state: 'pending', roots: new Set() };
}

function isLazy(value: unknown): value is LazyComponent {
  return Boolean(value && typeof value === 'object' && (value as LazyComponent).__nativeLazy);
}

function loadLazy(component: LazyComponent) {
  if (component.promise) return;
  component.promise = component.loader()
    .then((module) => {
      component.component = module.default;
      component.state = 'ready';
    })
    .catch((error) => {
      component.error = error;
      component.state = 'error';
    })
    .finally(() => {
      component.roots.forEach(schedule);
      component.roots.clear();
    });
}

function eventName(name: string, element: Element) {
  if (name === 'onDoubleClick') return 'dblclick';
  if (name === 'onChange') return element instanceof HTMLSelectElement ? 'change' : 'input';
  return name.slice(2).toLowerCase();
}

function svgAttributeName(name: string) {
  if (name === 'viewBox' || name === 'preserveAspectRatio') return name;
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function setElementEventHandler(element: Element, event: string, handler: EventListener) {
  let state = elementEventStates.get(element);
  if (!state) {
    state = { handlers: new Map(), registered: new Set() };
    elementEventStates.set(element, state);
  }
  state.handlers.set(event, handler);
  if (state.registered.has(event)) return;
  state.registered.add(event);
  element.addEventListener(event, (nativeEvent) => state?.handlers.get(event)?.call(element, nativeEvent));
}

function applyElementRef(element: Element, ref: unknown) {
  if (typeof ref === 'function') (ref as (node: Element) => void)(element);
  else if (typeof ref === 'object' && ref) (ref as { current: Element | null }).current = element;
}

function applyProps(element: Element, props: Record<string, unknown>, inSvg: boolean) {
  Object.entries(props).forEach(([name, value]) => {
    if (name === 'children' || name === 'key' || value === undefined || value === null) return;
    if (name === 'ref') {
      elementRefs.set(element, value);
      applyElementRef(element, value);
      return;
    }
    if (name.startsWith('on') && typeof value === 'function') {
      // onChange untuk input native dipetakan ke event input. Jika komponen juga
      // menyediakan onInput, memasang keduanya membuat satu ketikan diproses dua kali.
      if (name === 'onChange' && !(element instanceof HTMLSelectElement) && typeof props.onInput === 'function') return;
      setElementEventHandler(element, eventName(name, element), value as EventListener);
      return;
    }
    if (name === 'className') {
      element.setAttribute('class', String(value));
      return;
    }
    if (name === 'htmlFor') {
      element.setAttribute('for', String(value));
      return;
    }
    if (name === 'style' && typeof value === 'object') {
      Object.entries(value as Record<string, string | number>).forEach(([property, styleValue]) => {
        const cssProperty = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        (element as HTMLElement).style.setProperty(cssProperty, String(styleValue));
      });
      return;
    }
    if (!inSvg && element instanceof HTMLSelectElement && name === 'value') return;
    if (!inSvg && name in element && !name.startsWith('aria-') && !name.startsWith('data-')) {
      try {
        (element as unknown as Record<string, unknown>)[name] = value;
        return;
      } catch {
        // Read-only browser properties fall back to attributes.
      }
    }
    const attribute = inSvg ? svgAttributeName(name) : name.toLowerCase();
    if (value === false) element.removeAttribute(attribute);
    else if (value === true) element.setAttribute(attribute, '');
    else element.setAttribute(attribute, String(value));
  });
}

function focusKey(element: Element, cursor: number) {
  const identity = element.getAttribute('id') || element.getAttribute('name');
  return identity ? `${element.tagName}:${identity}` : `${element.tagName}:${cursor}`;
}

export function createElement(
  type: string | Component | LazyComponent | symbol,
  props: Record<string, unknown> | null,
  ...children: DomChild[]
): Node {
  const nextProps = { ...(props || {}) };
  if (children.length === 1) nextProps.children = children[0];
  else if (children.length > 1) nextProps.children = children;

  if (type === Fragment || type === StrictMode || type === Suspense) {
    return asNode(nextProps.children as DomChild);
  }
  if (isLazy(type)) {
    if (type.state === 'error') throw type.error;
    if (type.state === 'ready' && type.component) return renderComponent(type.component, nextProps);
    if (activeRoot) type.roots.add(activeRoot);
    loadLazy(type);
    const loading = document.createElement('div');
    loading.className = 'py-12 text-center text-slate-400';
    loading.textContent = 'Memuat Halaman...';
    return loading;
  }
  if (typeof type === 'function') return renderComponent(type, nextProps);
  if (typeof type !== 'string') return document.createDocumentFragment();

  const inSvg = SVG_ELEMENTS.has(type);
  const element = inSvg
    ? document.createElementNS('http://www.w3.org/2000/svg', type)
    : document.createElement(type);
  const svgElement = element.namespaceURI === 'http://www.w3.org/2000/svg';
  applyProps(element, nextProps, inSvg || svgElement);
  appendChild(element, nextProps.children as DomChild);
  if (element instanceof HTMLSelectElement && nextProps.value !== undefined && nextProps.value !== null) {
    element.value = String(nextProps.value);
  }
  if (activeRoot && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
    element.dataset.domFocusKey = focusKey(element, activeRoot.elementCursor++);
  }
  return element;
}

function activeField(container: HTMLElement) {
  const element = document.activeElement as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  if (!element || !container.contains(element)) return null;
  return {
    key: element.dataset.domFocusKey,
    value: element.value,
    selectionStart: 'selectionStart' in element ? element.selectionStart : null,
    selectionEnd: 'selectionEnd' in element ? element.selectionEnd : null,
    selectionDirection: 'selectionDirection' in element ? element.selectionDirection : null
  };
}

function restoreActiveField(container: HTMLElement, active: ReturnType<typeof activeField>) {
  if (!active?.key) return;
  const field = Array.from(container.querySelectorAll<HTMLElement>('[data-dom-focus-key]'))
    .find((element) => element.dataset.domFocusKey === active.key);
  if (!field) return;
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) {
    if (!(field instanceof HTMLInputElement) || field.type !== 'file') field.value = active.value;
  }
  field.focus({ preventScroll: true });
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    try {
      field.setSelectionRange(active.selectionStart, active.selectionEnd, active.selectionDirection ?? undefined);
    } catch {
      // Number and date inputs do not expose a text selection.
    }
  }
}

function sameNodeType(current: Node, next: Node) {
  if (current.nodeType !== next.nodeType) return false;
  if (current instanceof Element && next instanceof Element) {
    return current.namespaceURI === next.namespaceURI && current.tagName === next.tagName;
  }
  return true;
}

function syncAttributes(current: Element, next: Element) {
  Array.from(current.attributes).forEach((attribute) => {
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  });
  Array.from(next.attributes).forEach((attribute) => {
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  });
}

function syncEventHandlers(current: Element, next: Element) {
  const nextState = elementEventStates.get(next);
  const currentState = elementEventStates.get(current);
  currentState?.handlers.clear();
  nextState?.handlers.forEach((handler, event) => setElementEventHandler(current, event, handler));
}

function syncFormControl(current: Element, next: Element) {
  const isActive = document.activeElement === current;
  if (current instanceof HTMLInputElement && next instanceof HTMLInputElement) {
    current.checked = next.checked;
    current.indeterminate = next.indeterminate;
    if (!isActive && current.type !== 'file') current.value = next.value;
    return;
  }
  if (current instanceof HTMLTextAreaElement && next instanceof HTMLTextAreaElement) {
    if (!isActive) current.value = next.value;
    return;
  }
  if (current instanceof HTMLSelectElement && next instanceof HTMLSelectElement && !isActive) {
    current.value = next.value;
  }
}

function reconcileChildren(currentParent: Node, nextParent: Node) {
  const nextChildren = Array.from(nextParent.childNodes);
  nextChildren.forEach((nextChild, index) => {
    const currentChild = currentParent.childNodes[index];
    if (!currentChild) {
      currentParent.appendChild(nextChild);
      return;
    }
    patchNode(currentChild, nextChild);
  });
  while (currentParent.childNodes.length > nextChildren.length) {
    currentParent.lastChild?.remove();
  }
}

function patchNode(current: Node, next: Node) {
  if (!sameNodeType(current, next)) {
    current.parentNode?.replaceChild(next, current);
    return;
  }
  if (current instanceof Text && next instanceof Text) {
    if (current.data !== next.data) current.data = next.data;
    return;
  }
  if (!(current instanceof Element) || !(next instanceof Element)) return;
  syncAttributes(current, next);
  syncEventHandlers(current, next);
  const ref = elementRefs.get(next);
  if (ref !== undefined) {
    elementRefs.set(current, ref);
    applyElementRef(current, ref);
  }
  reconcileChildren(current, next);
  syncFormControl(current, next);
}

function flushEffects(root: DomRoot, kind: EffectHook['kind']) {
  root.instances.forEach((instance) => {
    instance.hooks.forEach((hook) => {
      if (hook.kind !== kind || !hook.next) return;
      hook.cleanup?.();
      const cleanup = hook.next();
      hook.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
      hook.next = undefined;
    });
  });
}

function renderRoot(root: DomRoot) {
  if (root.disposed) return;
  const focused = activeField(root.container);
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  root.componentCursor = 0;
  root.elementCursor = 0;
  const previousRoot = activeRoot;
  activeRoot = root;
  let content: Node;
  try {
    content = asNode(root.renderView());
  } catch (error) {
    console.error('Gagal merender halaman:', error);
    activeRoot = previousRoot;
    return;
  }
  activeRoot = previousRoot;
  Array.from(root.instances.entries()).forEach(([index, instance]) => {
    if (index < root.componentCursor) return;
    cleanupInstance(instance);
    root.instances.delete(index);
  });
  const nextRoot = document.createDocumentFragment();
  nextRoot.appendChild(content);
  reconcileChildren(root.container, nextRoot);
  restoreActiveField(root.container, focused);
  window.scrollTo(scrollX, scrollY);
  flushEffects(root, 'layout');
  queueMicrotask(() => flushEffects(root, 'effect'));
}

export function createRoot(container: HTMLElement) {
  const root: DomRoot = {
    container,
    renderView: () => null,
    instances: new Map(),
    componentCursor: 0,
    elementCursor: 0,
    scheduled: false,
    disposed: false
  };
  return {
    render(renderView: () => DomChild) {
      root.renderView = renderView;
      renderRoot(root);
    },
    unmount() {
      root.disposed = true;
      root.instances.forEach(cleanupInstance);
      root.instances.clear();
      root.container.replaceChildren();
    }
  };
}

const nativeDom = {
  Fragment,
  StrictMode,
  Suspense,
  createElement,
  forwardRef,
  lazy,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
};

export { Fragment, StrictMode, Suspense };
export default nativeDom;
