'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Boxes,
  Calculator,
  ChevronLeft,
  ChevronRight,
  Check,
  CircleDollarSign,
  ClipboardPaste,
  Cookie,
  Copy,
  CopyCheck,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Gauge,
  Link2,
  ListMusic,
  Mail,
  KeyRound,
  Music2,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  RotateCw,
  Search,
  ShieldCheck,
  Terminal,
  Trash2,
  UsersRound,
  WandSparkles,
  X,
} from 'lucide-react';
import { DEFAULT_OPENAI_MODEL, SUNO_MODEL_CATALOG } from '@/lib/suno-models';
import AdminShell from './components/AdminShell';
import styles from './AdminDashboard.module.css';

type Song = {
  id?: string;
  title?: string;
  status?: string;
  prompt?: string;
  tags?: string;
  audio_url?: string;
  image_url?: string;
  created_at?: string;
  duration?: number;
  error_message?: string;
};

type Quota = {
  credits_left?: number;
  period?: string;
  monthly_limit?: number;
  monthly_usage?: number;
};

type PoolAccount = {
  id: string;
  name: string;
  tier: 'basic' | 'super' | 'heavy';
  enabled: boolean;
  status: 'active' | 'cooling' | 'expired' | 'disabled';
  priority: number;
  maxConcurrent: number;
  creditsLeft: number | null;
  period?: string | null;
  monthlyLimit: number | null;
  monthlyUsage: number | null;
  health: number;
  inflight: number;
  failures: number;
  cooldownUntil: string | null;
  lastQuotaSync: string | null;
  lastError: string | null;
};


type CaptchaStatus = {
  provider: 'yescaptcha' | '2captcha' | 'none';
  providerSetting?: 'yescaptcha' | '2captcha' | 'auto';
  captchaMode?: 'auto' | 'token' | 'click';
  yescaptchaConfigured: boolean;
  twocaptchaConfigured: boolean;
  yescaptchaKeyMasked: string | null;
  twocaptchaKeyMasked: string | null;
  yescaptchaBaseUrl: string;
  yescaptchaBalance: number | null;
  yescaptchaError: string | null;
  updatedAt?: string;
  network?: {
    apiTransportMode: 'direct' | 'proxy';
    workerMode: 'proxyless' | 'external_proxy';
  };
  coordinator?: {
    active: number;
    limit: number;
    busyAccounts: number;
  };
  providers?: Record<string, {
    configured?: boolean;
    api?: { state?: 'unchecked' | 'reachable' | 'unreachable'; latencyMs?: number | null; code?: string | null };
    solve?: {
      attempts?: number;
      tokensReturned?: number;
      timeouts?: number;
      failures?: number;
      averageDurationMs?: number | null;
      lastCode?: string | null;
      lastAttemptAt?: string | null;
      lastDurationMs?: number | null;
    };
    suno?: { accepted?: number; captchaRejected?: number; indeterminate?: number };
    circuit?: { state?: 'closed' | 'open'; retryAfterSeconds?: number };
  }>;
};

type ApiKeyStatus = {
  enabled: boolean;
  configured: boolean;
  apiKeyMasked: string | null;
  updatedAt?: string;
};

type BillingSettings = {
  purchaseCostCny: number;
  purchasedCredits: number;
  creditsPerGeneration: number;
  outputsPerGeneration: number;
  rateMultiplier: number;
  cnyPerUsd: number;
  updatedAt?: string;
};

type BillingForm = Record<
  'purchaseCostCny' | 'purchasedCredits' | 'creditsPerGeneration' | 'outputsPerGeneration' | 'rateMultiplier' | 'cnyPerUsd',
  string
>;

type ConcurrencyStatus = {
  settings: {
    maxConcurrentRequests: number;
    updatedAt?: string;
  };
  activeRequests: number;
  availableSlots: number;
  message?: string;
};

type View = 'overview' | 'accounts' | 'concurrency' | 'generate' | 'tasks' | 'captcha' | 'apikey' | 'billing' | 'models';
type PoolFilter = 'all' | 'basic' | 'super' | 'heavy';
type AccountStatusFilter = 'all' | PoolAccount['status'];
type TaskFilter = 'all' | 'active' | 'complete' | 'error';
type AuthMethod = 'extension' | 'link' | 'password' | 'manual';
type AuthStep = 1 | 2 | 3;

const tierLabels: Record<PoolFilter, string> = {
  all: '全部',
  basic: 'basic',
  super: 'super',
  heavy: 'heavy',
};

const accountStatusLabels: Record<AccountStatusFilter, string> = {
  all: '全部状态',
  active: '正常',
  cooling: '冷却中',
  expired: '已过期',
  disabled: '已停用',
};

const taskFilterLabels: Record<TaskFilter, string> = {
  all: '全部任务',
  active: '进行中',
  complete: '已完成',
  error: '失败',
};

const modelDescriptions: Record<string, string> = {
  'suno-music': '推荐的 OpenAI 兼容别名，自动使用当前最新模型。',
  'suno-v5.5': '当前最新模型，上游标识为 chirp-fenix；需要账号具备对应权限。',
  'suno-v5': 'Suno V5，上游标识为 chirp-crow。',
  'suno-v4.5+': '增强版 V4.5，上游标识为 chirp-bluejay。',
  'suno-v4.5': 'Suno V4.5，上游标识为 chirp-auk。',
  'suno-v4': '旧版 V4，是否可用取决于 Suno 账号。',
  'suno-v3.5': '旧版 V3.5，是否可用取决于 Suno 账号。',
  'suno-v3': '旧版 V3，是否可用取决于 Suno 账号。',
};

const TASKS_PER_PAGE = 8;

const DEFAULT_BILLING_FORM: BillingForm = {
  purchaseCostCny: '120',
  purchasedCredits: '2500',
  creditsPerGeneration: '10',
  outputsPerGeneration: '2',
  rateMultiplier: '1',
  cnyPerUsd: '1',
};

function toBillingForm(settings?: Partial<BillingSettings> | null): BillingForm {
  return {
    purchaseCostCny: String(settings?.purchaseCostCny ?? DEFAULT_BILLING_FORM.purchaseCostCny),
    purchasedCredits: String(settings?.purchasedCredits ?? DEFAULT_BILLING_FORM.purchasedCredits),
    creditsPerGeneration: String(settings?.creditsPerGeneration ?? DEFAULT_BILLING_FORM.creditsPerGeneration),
    outputsPerGeneration: String(settings?.outputsPerGeneration ?? DEFAULT_BILLING_FORM.outputsPerGeneration),
    rateMultiplier: String(settings?.rateMultiplier ?? DEFAULT_BILLING_FORM.rateMultiplier),
    cnyPerUsd: String(settings?.cnyPerUsd ?? DEFAULT_BILLING_FORM.cnyPerUsd),
  };
}

function formatMoney(value: number, symbol = '¥', maximumFractionDigits = 4) {
  if (!Number.isFinite(value)) return '--';
  return `${symbol}${new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(value)}`;
}

function formatQuantity(value: number, maximumFractionDigits = 2) {
  if (!Number.isFinite(value)) return '--';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits }).format(value);
}

function formatDate(value?: string | null) {
  if (!value) return '暂无记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatNumber(value?: number | null) {
  if (value === undefined || value === null || Number.isNaN(value)) return '--';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);
}

function healthPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

function songStatusLabel(status?: string) {
  const labels: Record<string, string> = {
    complete: '已完成',
    streaming: '生成中',
    submitted: '已提交',
    queued: '排队中',
    error: '失败',
  };
  return labels[status || ''] || '未知状态';
}

function accountStatusLabel(status: PoolAccount['status']) {
  return { active: '正常', cooling: '冷却中', expired: '已过期', disabled: '已停用' }[status];
}

function statusBadgeClass(status?: string) {
  if (status === 'complete' || status === 'active') return styles.badgeGreen;
  if (status === 'streaming' || status === 'submitted' || status === 'queued') return styles.badgeBlue;
  if (status === 'cooling') return styles.badgeAmber;
  if (status === 'error' || status === 'expired') return styles.badgeRed;
  return styles.badgeGray;
}

export default function AdminDashboard() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [quota, setQuota] = useState<Quota | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [accounts, setAccounts] = useState<PoolAccount[]>([]);
  const [prompt, setPrompt] = useState('');
  const [instrumental, setInstrumental] = useState(false);
  const [generationPool, setGenerationPool] = useState<'basic' | 'super' | 'heavy'>('basic');
  const [generationModel, setGenerationModel] = useState(DEFAULT_OPENAI_MODEL);
  const [accountName, setAccountName] = useState('');
  const [accountCookie, setAccountCookie] = useState('');
  const [accountTier, setAccountTier] = useState<'basic' | 'super' | 'heavy'>('basic');
  const [accountBusy, setAccountBusy] = useState(false);
  const [showAuthWizard, setShowAuthWizard] = useState(false);
  const [authStep, setAuthStep] = useState<AuthStep>(1);
  const [authMethod, setAuthMethod] = useState<AuthMethod>('extension');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [showAuthPassword, setShowAuthPassword] = useState(false);
  const [showAdvancedTools, setShowAdvancedTools] = useState(false);
  const [verifyingCookie, setVerifyingCookie] = useState(false);
  const [verifyResult, setVerifyResult] = useState<string>('');
  const [copiedCommand, setCopiedCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [activeView, setActiveView] = useState<View>('overview');
  const [poolFilter, setPoolFilter] = useState<PoolFilter>('all');
  const [accountStatusFilter, setAccountStatusFilter] = useState<AccountStatusFilter>('all');
  const [accountQuery, setAccountQuery] = useState('');
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('all');
  const [taskQuery, setTaskQuery] = useState('');
  const [taskPage, setTaskPage] = useState(1);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [apiBase, setApiBase] = useState('--');
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [captchaStatus, setCaptchaStatus] = useState<CaptchaStatus | null>(null);
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const [captchaSaving, setCaptchaSaving] = useState(false);
  const [captchaProbeLoading, setCaptchaProbeLoading] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus | null>(null);
  const [apiKeyForm, setApiKeyForm] = useState({ enabled: true, apiKey: '', showKey: false });
  const [apiKeyLoading, setApiKeyLoading] = useState(false);
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyPlain, setApiKeyPlain] = useState('');
  const [billingForm, setBillingForm] = useState<BillingForm>(DEFAULT_BILLING_FORM);
  const [billingUpdatedAt, setBillingUpdatedAt] = useState<string | undefined>();
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingSaving, setBillingSaving] = useState(false);
  const billingDirtyRef = useRef(false);
  const dashboardRequestRef = useRef(false);
  const [concurrencyStatus, setConcurrencyStatus] = useState<ConcurrencyStatus | null>(null);
  const [concurrencyLimit, setConcurrencyLimit] = useState('4');
  const [concurrencyLoading, setConcurrencyLoading] = useState(false);
  const [concurrencySaving, setConcurrencySaving] = useState(false);
  const concurrencyDirtyRef = useRef(false);
  const [captchaForm, setCaptchaForm] = useState({
    provider: 'auto' as 'auto' | 'yescaptcha' | '2captcha',
    captchaMode: 'auto' as 'auto' | 'token' | 'click',
    yescaptchaKey: '',
    twocaptchaKey: '',
    yescaptchaBaseUrl: 'https://api.yescaptcha.com',
    showYesKey: false,
    showTwoKey: false,
  });

  const billingPreview = useMemo(() => {
    const purchaseCostCny = Number(billingForm.purchaseCostCny);
    const purchasedCredits = Number(billingForm.purchasedCredits);
    const creditsPerGeneration = Number(billingForm.creditsPerGeneration);
    const outputsPerGeneration = Number(billingForm.outputsPerGeneration);
    const rateMultiplier = Number(billingForm.rateMultiplier);
    const cnyPerUsd = Number(billingForm.cnyPerUsd);
    const values = [
      purchaseCostCny,
      purchasedCredits,
      creditsPerGeneration,
      outputsPerGeneration,
      rateMultiplier,
      cnyPerUsd,
    ];
    const valid = values.every((value) => Number.isFinite(value) && value > 0);
    if (!valid) {
      return {
        valid: false,
        costPerCreditCny: 0,
        costPerGenerationCny: 0,
        costPerOutputCny: 0,
        billingPointsPerGeneration: 0,
        billingPointsPerOutput: 0,
        totalBillablePoints: 0,
        generationsPerPackage: 0,
        outputsPerPackage: 0,
        referencePackageValueCny: 0,
        referenceGenerationValueCny: 0,
        grossMarginPercent: 0,
        sub2apiPerRequestPriceUsd: 0,
        sub2apiEffectivePriceUsd: 0,
        rateMultiplier,
        outputsPerGeneration,
      };
    }

    const costPerCreditCny = purchaseCostCny / purchasedCredits;
    const costPerGenerationCny = costPerCreditCny * creditsPerGeneration;
    const costPerOutputCny = costPerGenerationCny / outputsPerGeneration;
    const generationsPerPackage = Math.floor(purchasedCredits / creditsPerGeneration);
    const referencePackageValueCny = purchaseCostCny * rateMultiplier;
    const referenceGenerationValueCny = costPerGenerationCny * rateMultiplier;

    return {
      valid: true,
      costPerCreditCny,
      costPerGenerationCny,
      costPerOutputCny,
      billingPointsPerGeneration: creditsPerGeneration * rateMultiplier,
      billingPointsPerOutput: (creditsPerGeneration * rateMultiplier) / outputsPerGeneration,
      totalBillablePoints: purchasedCredits * rateMultiplier,
      generationsPerPackage,
      outputsPerPackage: generationsPerPackage * outputsPerGeneration,
      referencePackageValueCny,
      referenceGenerationValueCny,
      grossMarginPercent: ((referencePackageValueCny - purchaseCostCny) / referencePackageValueCny) * 100,
      sub2apiPerRequestPriceUsd: costPerGenerationCny / cnyPerUsd,
      sub2apiEffectivePriceUsd: referenceGenerationValueCny / cnyPerUsd,
      rateMultiplier,
      outputsPerGeneration,
    };
  }, [billingForm]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    setApiBase(window.location.origin);
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const views: View[] = ['overview', 'accounts', 'concurrency', 'generate', 'tasks', 'captcha', 'apikey', 'billing', 'models'];
    const syncFromLocation = () => {
      const requestedView = window.location.hash.replace(/^#/, '') as View;
      if (views.includes(requestedView)) setActiveView(requestedView);
    };
    syncFromLocation();
    window.addEventListener('hashchange', syncFromLocation);
    return () => window.removeEventListener('hashchange', syncFromLocation);
  }, []);

  useEffect(() => {
    if (!showAuthWizard) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || accountBusy || verifyingCookie) return;
      setShowAuthWizard(false);
      setAuthStep(1);
      setVerifyResult('');
      setCopiedCommand('');
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [accountBusy, showAuthWizard, verifyingCookie]);

  const loadDashboard = useCallback(async () => {
    if (dashboardRequestRef.current) return;
    dashboardRequestRef.current = true;
    setRefreshing(true);
    setError('');
    try {
      const [limitResponse, songsResponse, accountsResponse, captchaResponse, apiKeyResponse, billingResponse, concurrencyResponse] = await Promise.all([
        fetch('/api/admin/limit', { cache: 'no-store' }),
        fetch('/api/admin/songs', { cache: 'no-store' }),
        fetch('/api/admin/accounts', { cache: 'no-store' }),
        fetch('/api/admin/captcha', { cache: 'no-store' }),
        fetch('/api/admin/apikey', { cache: 'no-store' }),
        fetch('/api/admin/billing', { cache: 'no-store' }),
        fetch('/api/admin/concurrency', { cache: 'no-store' }),
      ]);
      const limitData = await limitResponse.json();
      const songsData = await songsResponse.json();
      const accountsData = await accountsResponse.json();
      const captchaData = await captchaResponse.json();
      const apiKeyData = await apiKeyResponse.json();
      const billingData = await billingResponse.json();
      const concurrencyData = await concurrencyResponse.json();
      const errors: string[] = [];
      if (limitResponse.ok) setQuota(limitData);
      else errors.push(limitData.error || '积分信息暂时无法读取。');
      if (songsResponse.ok) setSongs(Array.isArray(songsData) ? songsData : []);
      else errors.push(songsData.error || '任务列表暂时无法读取。');
      if (accountsResponse.ok) setAccounts(Array.isArray(accountsData) ? accountsData : []);
      else errors.push(accountsData.error || '账号池暂时无法读取。');

      if (captchaResponse.ok) {
        setCaptchaStatus(captchaData);
        setCaptchaForm((prev) => ({
          ...prev,
          provider: captchaData.providerSetting || (captchaData.provider === 'none' ? 'auto' : captchaData.provider) || 'auto',
          captchaMode: captchaData.captchaMode || 'auto',
          yescaptchaBaseUrl: captchaData.yescaptchaBaseUrl || 'https://api.yescaptcha.com',
          // keep typed secrets if user already edited this session
          yescaptchaKey: prev.yescaptchaKey,
          twocaptchaKey: prev.twocaptchaKey,
        }));
      }
      else errors.push(captchaData.error || '验证码配置暂时无法读取。');

      if (apiKeyResponse.ok) {
        setApiKeyStatus(apiKeyData);
        setApiKeyForm((prev) => ({
          ...prev,
          enabled: Boolean(apiKeyData.enabled),
        }));
      } else {
        errors.push(apiKeyData.error || '接口密钥配置暂时无法读取。');
      }

      if (billingResponse.ok) {
        if (!billingDirtyRef.current) {
          setBillingForm(toBillingForm(billingData.settings));
          setBillingUpdatedAt(billingData.settings?.updatedAt);
        }
      } else {
        errors.push(billingData.error || '计费配置暂时无法读取。');
      }

      if (concurrencyResponse.ok) {
        setConcurrencyStatus(concurrencyData);
        if (!concurrencyDirtyRef.current) {
          setConcurrencyLimit(String(concurrencyData.settings?.maxConcurrentRequests ?? 4));
        }
      } else {
        errors.push(concurrencyData.error || '并发配置暂时无法读取。');
      }
      if (errors.length > 0) setError(Array.from(new Set(errors)).join(' '));
      setLastUpdated(new Date().toISOString());
    } catch (loadError: any) {
      setError(loadError?.message || '无法连接管理接口。');
    } finally {
      dashboardRequestRef.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetch('/api/admin/session', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        setConfigured(Boolean(data.configured));
        setAuthenticated(Boolean(data.authenticated));
        if (data.authenticated) loadDashboard();
      })
      .catch(() => setError('无法连接登录接口。'));
  }, [loadDashboard]);

  useEffect(() => {
    if (!authenticated) return undefined;
    const timer = window.setInterval(loadDashboard, 15000);
    return () => window.clearInterval(timer);
  }, [authenticated, loadDashboard]);

  const usage = useMemo(() => {
    const withLimit = accounts.filter((account) => account.monthlyLimit !== null);
    if (withLimit.length > 0) {
      return {
        used: withLimit.reduce((sum, account) => sum + (account.monthlyUsage || 0), 0),
        limit: withLimit.reduce((sum, account) => sum + (account.monthlyLimit || 0), 0),
      };
    }
    return { used: quota?.monthly_usage || 0, limit: quota?.monthly_limit || 0 };
  }, [accounts, quota]);

  const usagePercent = usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
  const totalCredits = useMemo(() => {
    const knownCredits = accounts.filter((account) => account.creditsLeft !== null);
    if (knownCredits.length > 0) return knownCredits.reduce((sum, account) => sum + (account.creditsLeft || 0), 0);
    return quota?.credits_left ?? null;
  }, [accounts, quota]);
  const activeAccounts = accounts.filter((account) => account.enabled && account.status === 'active').length;
  const healthyAccounts = accounts.filter((account) => account.health >= 0.7 && account.status !== 'expired').length;
  const inflight = accounts.reduce((sum, account) => sum + account.inflight, 0);
  const poolCounts = useMemo(() => ({
    basic: accounts.filter((account) => account.tier === 'basic').length,
    super: accounts.filter((account) => account.tier === 'super').length,
    heavy: accounts.filter((account) => account.tier === 'heavy').length,
  }), [accounts]);
  const filteredAccounts = useMemo(() => {
    const query = accountQuery.trim().toLowerCase();
    return accounts.filter((account) => {
      const matchesPool = poolFilter === 'all' || account.tier === poolFilter;
      const matchesStatus = accountStatusFilter === 'all' || account.status === accountStatusFilter;
      const matchesQuery = !query || [account.name, account.id, account.lastError || ''].some((value) => value.toLowerCase().includes(query));
      return matchesPool && matchesStatus && matchesQuery;
    });
  }, [accountQuery, accountStatusFilter, accounts, poolFilter]);

  const filteredSongs = useMemo(() => {
    const query = taskQuery.trim().toLowerCase();
    return songs.filter((song) => {
      const status = song.status || '';
      const matchesStatus = taskFilter === 'all'
        || (taskFilter === 'active' && ['streaming', 'submitted', 'queued'].includes(status))
        || (taskFilter === 'complete' && status === 'complete')
        || (taskFilter === 'error' && status === 'error');
      const matchesQuery = !query || [song.title || '', song.prompt || '', song.id || ''].some((value) => value.toLowerCase().includes(query));
      return matchesStatus && matchesQuery;
    });
  }, [songs, taskFilter, taskQuery]);

  const taskCounts = useMemo(() => ({
    all: songs.length,
    active: songs.filter((song) => ['streaming', 'submitted', 'queued'].includes(song.status || '')).length,
    complete: songs.filter((song) => song.status === 'complete').length,
    error: songs.filter((song) => song.status === 'error').length,
  }), [songs]);
  const totalTaskPages = Math.max(1, Math.ceil(filteredSongs.length / TASKS_PER_PAGE));
  const currentTaskPage = Math.min(taskPage, totalTaskPages);
  const visibleSongs = filteredSongs.slice((currentTaskPage - 1) * TASKS_PER_PAGE, currentTaskPage * TASKS_PER_PAGE);
  const apiEndpoint = apiBase === '--' ? '--' : `${apiBase}/v1`;

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginError('');
    const response = await fetch('/api/admin/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await response.json();
    if (!response.ok) {
      setLoginError(data.error || '密码不正确。');
      return;
    }
    setPassword('');
    setAuthenticated(true);
    loadDashboard();
  }

  async function logout() {
    await fetch('/api/admin/session', { method: 'DELETE' });
    setAuthenticated(false);
    setQuota(null);
    setSongs([]);
    setAccounts([]);
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim()) {
      setError('请输入生成提示词。');
      return;
    }
    setBusy(true);
    setMessage('正在提交生成任务…');
    setError('');
    try {
      const response = await fetch('/api/admin/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, make_instrumental: instrumental, wait_audio: false, pool: generationPool, model: generationModel }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '生成请求失败。');
      setSongs((current) => [...(Array.isArray(data) ? data : []), ...current]);
      setPrompt('');
      setMessage('任务已提交，正在同步积分…');
      setActiveView('generate');
      try {
        await fetch('/api/admin/accounts/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      } catch {}
      await loadDashboard();
      setMessage('任务已提交，积分已同步。');
    } catch (generateError: any) {
      setMessage('');
      setError(generateError?.message || '生成请求失败。');
    } finally {
      setBusy(false);
    }
  }

  function openAuthWizard() {
    setShowAuthWizard(true);
    setAuthStep(1);
    setAuthMethod('extension');
    setAccountName('');
    setAccountCookie('');
    setAccountTier('basic');
    setAuthEmail('');
    setAuthPassword('');
    setShowAuthPassword(false);
    setShowAdvancedTools(false);
    setVerifyResult('');
    setCopiedCommand('');
    setError('');
  }

  function closeAuthWizard() {
    if (accountBusy || verifyingCookie) return;
    setShowAuthWizard(false);
    setAuthStep(1);
    setVerifyResult('');
    setCopiedCommand('');
  }

  function authMethodLabel(method: AuthMethod) {
    if (method === 'extension') return '浏览器插件提取';
    if (method === 'link') return '打开授权链接';
    if (method === 'password') return '账号密码登录';
    return '手动粘贴 Cookie';
  }

  function openSunoAuthPage() {
    window.open('https://suno.com/', '_blank', 'noopener,noreferrer');
  }

  function extractorCommand() {
    if (authMethod === 'password' && authEmail.trim()) {
      const email = authEmail.trim().replace(/"/g, '');
      const password = (authPassword || '***').replace(/"/g, '\\"');
      return `npm run get-cookie -- --email "${email}" --password "${password}" --save`;
    }
    if (authMethod === 'password') return 'npm run get-cookie -- --email you@example.com --password "***" --save';
    return 'npm run get-cookie -- --manual --save';
  }
  async function copyText(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedCommand(key);
      window.setTimeout(() => setCopiedCommand(''), 1800);
    } catch {
      setError('复制失败，请手动选择命令文本。');
    }
  }

  async function verifyCookie() {
    if (!accountCookie.trim()) {
      setError('请先粘贴包含 __client 的 Cookie。');
      return false;
    }
    setVerifyingCookie(true);
    setError('');
    setVerifyResult('');
    try {
      const response = await fetch('/api/admin/accounts/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie: accountCookie }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Cookie 校验失败。');
      const credits = data?.quota?.credits_left;
      const usage = data?.quota?.monthly_usage;
      const limit = data?.quota?.monthly_limit;
      setVerifyResult(
        `校验通过：剩余积分 ${formatNumber(credits)}，本月 ${formatNumber(usage)} / ${formatNumber(limit)}`,
      );
      return true;
    } catch (verifyError: any) {
      setVerifyResult('');
      setError(verifyError?.message || 'Cookie 校验失败。');
      return false;
    } finally {
      setVerifyingCookie(false);
    }
  }

  async function addAccount(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!accountCookie.trim()) {
      setError('请先填写 Suno Cookie。');
      return;
    }
    setAccountBusy(true);
    setError('');
    setMessage('正在保存账号并同步配额…');
    try {
      const response = await fetch('/api/admin/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: accountName || (authMethod === 'password' ? (authEmail.trim() || '密码登录账号') : authMethod === 'manual' ? '手动 Cookie 账号' : authMethod === 'extension' ? '插件提取账号' : '授权链接账号'),
          cookie: accountCookie,
          tier: accountTier,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '账号保存失败。');
      setAccountName('');
      setAccountCookie('');
      setShowAuthWizard(false);
      setAuthStep(1);
      setVerifyResult('');
      setMessage(data.warning ? `账号已保存，但配额同步失败：${data.warning}` : '账号已保存，配额同步完成。');
      await loadDashboard();
    } catch (accountError: any) {
      setMessage('');
      setError(accountError?.message || '账号保存失败。');
    } finally {
      setAccountBusy(false);
    }
  }

  async function verifyAndSave() {
    const ok = await verifyCookie();
    if (!ok) return;
    await addAccount();
  }

  async function updateAccount(id: string, values: Record<string, unknown>) {
    setAccountBusy(true);
    setError('');
    try {
      const response = await fetch('/api/admin/accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...values }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '账号更新失败。');
      setMessage('账号设置已更新。');
      await loadDashboard();
    } catch (accountError: any) {
      setError(accountError?.message || '账号更新失败。');
    } finally {
      setAccountBusy(false);
    }
  }

  async function deleteAccount(id: string) {
    setAccountBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/admin/accounts?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '账号删除失败。');
      setPendingDelete(null);
      setMessage('账号已从池中移除。');
      await loadDashboard();
    } catch (accountError: any) {
      setError(accountError?.message || '账号删除失败。');
    } finally {
      setAccountBusy(false);
    }
  }

  async function refreshAccounts() {
    setAccountBusy(true);
    setError('');
    setMessage('正在同步全部账号配额…');
    try {
      const response = await fetch('/api/admin/accounts/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '配额同步失败。');
      setMessage(`配额同步完成：成功 ${data.refreshed} 个，失败 ${data.failed} 个。`);
      await loadDashboard();
    } catch (accountError: any) {
      setMessage('');
      setError(accountError?.message || '配额同步失败。');
    } finally {
      setAccountBusy(false);
    }
  }

  function switchView(view: View) {
    setActiveView(view);
    setSidebarOpen(false);
    if (window.location.hash !== `#${view}`) window.location.hash = view;
  }

  function renderPageHeader(title: string, subtitle: string, actions?: React.ReactNode) {
    return (
      <div className={styles.pageHeader}>
        <div className={styles.pageHeading}>
          <h1 className={styles.pageTitle}>{title}</h1>
          <p className={styles.pageSubtitle}>{subtitle}</p>
        </div>
        {actions ? <div className={styles.buttonRow}>{actions}</div> : null}
      </div>
    );
  }

  function renderStat(label: string, value: string, meta: string, icon: React.ReactNode, tone: string) {
    return (
      <article className={styles.statCard}>
        <div className={styles.statTop}>
          <span className={`${styles.statIcon} ${tone}`}>{icon}</span>
          <span className={styles.statLabel}>{label}</span>
        </div>
        <div className={styles.statValue}>{value}</div>
        <div className={styles.statMeta}>{meta}</div>
      </article>
    );
  }

  function renderTaskRow(song: Song, full = false) {
    const artwork = song.image_url
      ? <img className={`${styles.taskArtwork} ${full ? styles.fullArtwork : ''}`} src={song.image_url} alt="" />
      : <span className={`${styles.taskArtwork} ${full ? styles.fullArtwork : ''}`}><Music2 size={17} /></span>;
    if (!full) {
      return (
        <article className={styles.taskRow} key={song.id || `${song.title}-${song.created_at}`}>
          {artwork}
          <div className={styles.taskMain}>
            <div className={styles.taskTitle}>{song.title || '未命名任务'}</div>
            <div className={styles.taskDescription}>{song.prompt || '没有返回提示词'}</div>
          </div>
          <div className={styles.taskSide}>
            <span className={`${styles.badge} ${statusBadgeClass(song.status)}`}>{songStatusLabel(song.status)}</span>
            <span className={styles.taskTime}>{formatDate(song.created_at)}</span>
          </div>
        </article>
      );
    }
    return (
      <article className={styles.fullTaskRow} key={song.id || `${song.title}-${song.created_at}`}>
        {artwork}
        <div className={styles.taskMain}>
          <div className={styles.taskTitle}>{song.title || '未命名任务'}</div>
          <div className={styles.taskTime}>{formatDate(song.created_at)} {song.id ? `· ${song.id.slice(0, 8)}` : ''}</div>
        </div>
        <div className={styles.taskPrompt}>{song.error_message || song.prompt || '没有返回提示词'}</div>
        <div className={styles.taskSide}>
          <span className={`${styles.badge} ${statusBadgeClass(song.status)}`}>{songStatusLabel(song.status)}</span>
          {song.audio_url && <audio className={styles.audio} controls preload="none" src={song.audio_url} />}
        </div>
      </article>
    );
  }

  function renderOverview() {
    return (
      <>
        {renderPageHeader(
          '运行概览',
          '集中查看积分、账号池容量和任务执行情况。',
          <>
            <button className={styles.button} type="button" onClick={() => switchView('accounts')}>
              <Plus size={15} />添加账号
            </button>
            <button className={`${styles.button} ${styles.buttonPrimary}`} type="button" onClick={() => switchView('generate')}>
              <WandSparkles size={15} />生成音乐
            </button>
          </>,
        )}
        <section className={styles.operationStrip} aria-label="服务状态">
          <div className={styles.operationPrimary}>
            <span className={`${styles.connectionDot} ${activeAccounts === 0 ? styles.connectionDotWarning : ''}`} />
            <div>
              <strong>{activeAccounts > 0 ? '账号池可接收请求' : '账号池暂无可用账号'}</strong>
              <span>{healthyAccounts} / {accounts.length} 个账号健康，当前并发 {inflight}</span>
            </div>
          </div>
          <div className={styles.operationItems}>
            <div><span>接口鉴权</span><strong>{apiKeyStatus?.enabled ? '已启用' : '开放访问'}</strong></div>
            <div><span>验证码</span><strong>{captchaStatus?.provider === 'yescaptcha' ? 'YesCaptcha' : captchaStatus?.provider === '2captcha' ? '2Captcha' : '未配置'}</strong></div>
            <div><span>自动同步</span><strong>{formatDate(lastUpdated)}</strong></div>
          </div>
        </section>
        <div className={styles.statGrid}>
          {renderStat('可用积分', formatNumber(totalCredits), quota?.period || '当前计费周期', <CircleDollarSign size={16} />, styles.toneAmber)}
          {renderStat('可用账号', `${activeAccounts} / ${accounts.length}`, `${healthyAccounts} 个账号健康`, <UsersRound size={16} />, styles.toneGreen)}
          {renderStat('并发任务', formatNumber(inflight), '当前正在处理的请求', <Activity size={16} />, styles.toneCyan)}
          {renderStat('任务状态', `${taskCounts.active} 进行中`, `${taskCounts.complete} 已完成 · ${taskCounts.error} 失败`, <ListMusic size={16} />, taskCounts.error > 0 ? styles.toneRed : styles.toneBlue)}
        </div>
        <div className={styles.overviewGrid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h2 className={styles.panelTitle}>本月配额</h2>
                <p className={styles.panelDescription}>所有已同步账号的用量汇总</p>
              </div>
              <span className={styles.panelMeta}>{usage.limit ? `${usagePercent}%` : '暂无配额'}</span>
            </div>
            <div className={styles.panelBody}>
              <div className={styles.usageSummary}>
                <div className={styles.usageNumber}>{formatNumber(usage.used)}<span className={styles.usageLimit}>/ {formatNumber(usage.limit)}</span></div>
                <div className={styles.usagePercent}>{usagePercent}%</div>
              </div>
              <div className={`${styles.progressTrack} ${styles.usageProgress}`}><div className={styles.progressFill} style={{ width: `${usagePercent}%` }} /></div>
              <div className={styles.usageFootnote}>{formatNumber(Math.max(0, usage.limit - usage.used))} 额度尚未使用</div>
            </div>
          </section>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h2 className={styles.panelTitle}>账号池容量</h2>
                <p className={styles.panelDescription}>按 basic、super、heavy 分组</p>
              </div>
              <button className={styles.textButton} type="button" onClick={() => switchView('accounts')}>管理账号<ChevronRight size={14} /></button>
            </div>
            <div className={styles.poolStatusList}>
              {(['basic', 'super', 'heavy'] as const).map((tier) => {
                const tierAccounts = accounts.filter((account) => account.tier === tier);
                const tierActive = tierAccounts.filter((account) => account.enabled && account.status === 'active').length;
                const tierCredits = tierAccounts.reduce((sum, account) => sum + (account.creditsLeft || 0), 0);
                return (
                  <div className={styles.poolStatusRow} key={tier}>
                    <span className={`${styles.poolSwatch} ${styles[`poolSwatch${tier[0].toUpperCase()}${tier.slice(1)}`]}`} />
                    <div className={styles.poolStatusMain}><strong>{tier}</strong><span>{tierCredits} 可用积分</span></div>
                    <div className={styles.poolStatusValue}><strong>{tierActive}</strong><span>/ {tierAccounts.length} 可用</span></div>
                  </div>
                );
              })}
            </div>
          </section>
          <section className={`${styles.panel} ${styles.overviewTasksPanel}`}>
            <div className={styles.panelHeader}>
              <div>
                <h2 className={styles.panelTitle}>近期任务</h2>
                <p className={styles.panelDescription}>最近提交的音乐生成记录</p>
              </div>
              <button className={styles.textButton} type="button" onClick={() => switchView('tasks')}>查看全部<ChevronRight size={14} /></button>
            </div>
            {songs.length === 0
              ? <div className={styles.emptyState}><span className={styles.emptyIcon}><Music2 size={19} /></span><span className={styles.emptyTitle}>还没有任务记录</span><span className={styles.emptyText}>添加账号后，可以在音乐生成中提交第一首作品。</span></div>
              : <div className={styles.taskList}>{songs.slice(0, 6).map((song) => renderTaskRow(song))}</div>}
          </section>
        </div>
      </>
    );
  }

  function renderAccountRow(account: PoolAccount) {
    const health = healthPercent(account.health);
    return (
      <article className={styles.accountRow} key={account.id} role="row">
        <div className={styles.accountIdentity} role="cell">
          <div className={styles.accountName}>{account.name}</div>
          <div className={account.lastError ? styles.accountError : styles.accountId}>{account.lastError || `ID ${account.id.slice(0, 12)}`}</div>
        </div>
        <div className={styles.accountTier} role="cell">
          <span className={styles.mobileFieldLabel}>池级别</span>
          <select className={styles.tierSelect} value={account.tier} onChange={(event) => updateAccount(account.id, { tier: event.target.value })} disabled={accountBusy} aria-label={`${account.name} 账号池`}>
            <option value="basic">basic</option>
            <option value="super">super</option>
            <option value="heavy">heavy</option>
          </select>
        </div>
        <div className={styles.quotaCell} role="cell">
          <span className={styles.mobileFieldLabel}>配额</span>
          <div className={styles.quotaNumbers}><span>{formatNumber(account.creditsLeft)} 积分</span><span>{account.monthlyLimit ? `${formatNumber(account.monthlyUsage)} / ${formatNumber(account.monthlyLimit)}` : '未同步'}</span></div>
          <div className={styles.progressTrack}><div className={styles.progressFill} style={{ width: `${account.monthlyLimit ? Math.min(100, Math.round(((account.monthlyUsage || 0) / account.monthlyLimit) * 100)) : 0}%` }} /></div>
        </div>
        <div className={styles.healthCell} role="cell">
          <span className={styles.mobileFieldLabel}>健康度</span>
          <div className={styles.healthNumbers}><span>健康度</span><span className={styles.healthValue}>{health}%</span></div>
          <div className={styles.progressTrack}><div className={styles.progressFill} style={{ width: `${health}%`, background: health >= 70 ? '#36b779' : '#e6a23c' }} /></div>
        </div>
        <div className={styles.accountStatus} role="cell">
          <span className={styles.mobileFieldLabel}>状态</span>
          <span className={`${styles.badge} ${statusBadgeClass(account.status)}`}><span className={account.status === 'active' ? styles.connectionDot : undefined} />{accountStatusLabel(account.status)}</span>
          <span className={styles.concurrencyMeta}>{account.lastQuotaSync ? `同步于 ${formatDate(account.lastQuotaSync)}` : '尚未同步'}</span>
        </div>
        <div className={styles.concurrencyCell} role="cell">
          <span className={styles.mobileFieldLabel}>并发</span>
          <div className={styles.concurrencyControls}>
            <span className={styles.concurrencyLive}>{account.inflight}</span>
            <span className={styles.concurrencySlash}>/</span>
            <select
              className={styles.concurrencySelect}
              value={account.maxConcurrent}
              onChange={(event) => updateAccount(account.id, { maxConcurrent: Number(event.target.value) })}
              disabled={accountBusy}
              aria-label={`${account.name} 最大并发`}
              title="修改该账号最大并发（1-4）"
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
            </select>
          </div>
          <div className={styles.concurrencyMeta}>进行中 / 上限</div>
        </div>
        {pendingDelete === account.id ? (
          <div className={styles.deleteConfirm} role="cell">
            <button className={styles.confirmButton} type="button" onClick={() => deleteAccount(account.id)} disabled={accountBusy}>确认删除</button>
            <button className={styles.cancelButton} type="button" onClick={() => setPendingDelete(null)} disabled={accountBusy}>取消</button>
          </div>
        ) : (
          <div className={styles.rowActions} role="cell">
            <span className={styles.mobileFieldLabel}>操作</span>
            <button className={`${styles.iconButton} ${styles.smallIconButton}`} type="button" title={account.enabled ? '停用账号' : '启用账号'} aria-label={account.enabled ? '停用账号' : '启用账号'} onClick={() => updateAccount(account.id, { enabled: !account.enabled })} disabled={accountBusy}>
              {account.enabled ? <PowerOff size={15} /> : <Power size={15} />}
            </button>
            <button className={`${styles.iconButton} ${styles.smallIconButton}`} type="button" title="删除账号" aria-label="删除账号" onClick={() => setPendingDelete(account.id)} disabled={accountBusy}>
              <Trash2 size={15} />
            </button>
          </div>
        )}
      </article>
    );
  }

  function renderAuthWizard() {
    if (!showAuthWizard) return null;
    const methodCards: Array<{ id: AuthMethod; title: string; desc: string; icon: React.ReactNode; badge?: string }> = [
      {
        id: 'extension',
        title: '浏览器插件提取',
        desc: '安装 Suno Cookie Extractor，登录 suno.com 后一键自动提取 Cookie。',
        icon: <Cookie size={18} />,
        badge: '推荐',
      },
      {
        id: 'link',
        title: '打开授权链接',
        desc: '打开 Suno 授权页登录，再按步骤手动复制 Cookie。',
        icon: <Link2 size={18} />,
      },
      {
        id: 'password',
        title: '账号密码登录',
        desc: '填写邮箱密码后打开登录页完成授权，再粘贴 Cookie。',
        icon: <Mail size={18} />,
      },
      {
        id: 'manual',
        title: '手动粘贴 Cookie',
        desc: '已有 Cookie 时可直接粘贴，适合批量导入。',
        icon: <ClipboardPaste size={18} />,
      },
    ];

    return (
      <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="auth-wizard-title">
        <div className={styles.modalCard}>
          <div className={styles.modalHeader}>
            <div>
              <div className={styles.modalEyebrow}>账号授权</div>
              <h2 id="auth-wizard-title" className={styles.modalTitle}>添加账号</h2>
            </div>
            <button className={styles.iconButton} type="button" onClick={closeAuthWizard} aria-label="关闭" disabled={accountBusy || verifyingCookie}>
              <X size={18} />
            </button>
          </div>

          <div className={styles.stepper}>
            {[
              { step: 1, label: '选择方式' },
              { step: 2, label: '登录授权' },
              { step: 3, label: '完成绑定' },
            ].map((item) => (
              <div key={item.step} className={`${styles.stepItem} ${authStep === item.step ? styles.stepItemActive : ''} ${authStep > item.step ? styles.stepItemDone : ''}`}>
                <span className={styles.stepIndex}>{authStep > item.step ? <Check size={13} /> : item.step}</span>
                <span>{item.label}</span>
              </div>
            ))}
          </div>

          <div className={styles.modalBody}>
            {authStep === 1 && (
              <>
                <p className={styles.modalLead}>推荐安装浏览器插件一键提取。也可以打开授权链接、账号密码登录，或手动粘贴 Cookie。</p>
                <div className={styles.methodGrid}>
                  {methodCards.map((card) => (
                    <button
                      key={card.id}
                      type="button"
                      className={`${styles.methodCard} ${authMethod === card.id ? styles.methodCardActive : ''}`}
                      onClick={() => setAuthMethod(card.id)}
                    >
                      <div className={styles.methodTop}>
                        <span className={styles.methodIcon}>{card.icon}</span>
                        {card.badge && <span className={`${styles.badge} ${styles.badgeBlue}`}>{card.badge}</span>}
                      </div>
                      <div className={styles.methodTitle}>{card.title}</div>
                      <div className={styles.methodDesc}>{card.desc}</div>
                    </button>
                  ))}
                </div>
              </>
            )}

            {authStep === 2 && (
              <>
                {authMethod === 'extension' && (
                  <div className={styles.guidePanel}>
                    <div className={styles.guideTitle}><Cookie size={16} />使用浏览器插件自动提取</div>
                    <p className={styles.guideIntro}>先下载安装包到电脑，安装扩展后登录 suno.com，一键提取 Cookie 再粘贴到下方。</p>
                    <div className={styles.downloadBanner}>
                      <div className={styles.downloadBannerText}>
                        <strong>浏览器插件安装包</strong>
                        <span>Chrome / Edge 可用 · zip 约 9KB · 解压后加载即可</span>
                      </div>
                      <a className={`${styles.button} ${styles.buttonPrimary} ${styles.downloadPackageBtn}`} href="/suno-cookie-extension.zip" download="suno-cookie-extension.zip">
                        <Download size={15} />下载安装包
                      </a>
                    </div>
                    <div className={styles.extensionActions}>
                      <a className={`${styles.button} ${styles.authCtaSecondary}`} href="https://suno.com/" target="_blank" rel="noreferrer">
                        <ExternalLink size={15} />打开 Suno 登录
                      </a>
                      <a className={`${styles.button} ${styles.authCtaSecondary}`} href="/suno-cookie-extension.zip" download="suno-cookie-extension.zip">
                        <Download size={15} />再次下载安装包
                      </a>
                    </div>
                    <ol className={styles.guideList}>
                      <li>点击 <strong>下载安装包</strong>，把 zip 保存到电脑并解压。</li>
                      <li>打开 <code>chrome://extensions</code> 或 <code>edge://extensions</code>，开启右上角开发者模式。</li>
                      <li>点「加载已解压的扩展程序」，选择解压后的 <code>suno-cookie-extension</code> 文件夹。</li>
                      <li>浏览器打开并登录 <a href="https://suno.com" target="_blank" rel="noreferrer">suno.com</a>。</li>
                      <li>点击扩展图标 → <strong>一键提取 Cookie</strong> → 复制，再粘贴到下方。</li>
                    </ol>
                    <div className={styles.hintBox}>如果按钮没反应，可直接访问：<a href="/suno-cookie-extension.zip" download="suno-cookie-extension.zip">/suno-cookie-extension.zip</a></div>
                  </div>
                )}

                {authMethod === 'link' && (
                  <div className={styles.guidePanel}>
                    <div className={styles.guideTitle}><Link2 size={16} />打开授权链接并登录</div>
                    <p className={styles.guideIntro}>点击下方按钮打开 Suno 授权页，登录成功后把 Cookie 粘贴回来即可。</p>
                    <button className={`${styles.button} ${styles.buttonPrimary} ${styles.authCta}`} type="button" onClick={openSunoAuthPage}>
                      <ExternalLink size={15} />打开 Suno 授权页
                    </button>
                    <ol className={styles.guideList}>
                      <li>点击「打开 Suno 授权页」。</li>
                      <li>在新窗口完成登录（支持邮箱、Google、Apple）。</li>
                      <li>登录成功后按 <code>F12</code> → <code>Network</code>，刷新页面。</li>
                      <li>找到含 <code>client?_clerk_js_version</code> 的请求，复制 Cookie，粘贴到下方。</li>
                    </ol>
                  </div>
                )}

                {authMethod === 'password' && (
                  <div className={styles.guidePanel}>
                    <div className={styles.guideTitle}><Mail size={16} />使用账号密码登录授权</div>
                    <p className={styles.guideIntro}>先填写登录信息，再打开授权页完成登录，最后粘贴 Cookie。</p>
                    <div className={styles.authCredentialGrid}>
                      <label className={styles.field}>
                        <span className={styles.fieldLabel}>Suno 邮箱 / 账号</span>
                        <input
                          className={styles.input}
                          type="email"
                          autoComplete="username"
                          value={authEmail}
                          onChange={(event) => setAuthEmail(event.target.value)}
                          placeholder="you@example.com"
                        />
                      </label>
                      <label className={styles.field}>
                        <span className={styles.fieldLabel}>登录密码</span>
                        <div className={styles.passwordField}>
                          <input
                            className={styles.input}
                            type={showAuthPassword ? 'text' : 'password'}
                            autoComplete="current-password"
                            value={authPassword}
                            onChange={(event) => setAuthPassword(event.target.value)}
                            placeholder="输入账号密码"
                          />
                          <button
                            className={styles.passwordToggle}
                            type="button"
                            onClick={() => setShowAuthPassword((value) => !value)}
                            aria-label={showAuthPassword ? '隐藏密码' : '显示密码'}
                          >
                            {showAuthPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                          </button>
                        </div>
                      </label>
                    </div>
                    <button className={`${styles.button} ${styles.buttonPrimary} ${styles.authCta}`} type="button" onClick={openSunoAuthPage}>
                      <ExternalLink size={15} />打开登录页并授权
                    </button>
                    <ol className={styles.guideList}>
                      <li>在上方填写邮箱和密码（仅用于本页提示，不会上传到服务器）。</li>
                      <li>点击「打开登录页并授权」，在新窗口用同一账号登录。</li>
                      <li>登录成功后按 <code>F12</code> → <code>Network</code> 复制 Cookie，粘贴到下方。</li>
                    </ol>
                  </div>
                )}

                {authMethod === 'manual' && (
                  <div className={styles.guidePanel}>
                    <div className={styles.guideTitle}><ClipboardPaste size={16} />直接粘贴已有 Cookie</div>
                    <ol className={styles.guideList}>
                      <li>浏览器打开 <a href="https://suno.com" target="_blank" rel="noreferrer">suno.com</a> 并确保已登录。</li>
                      <li>按 <code>F12</code> → <code>Network</code>，刷新页面。</li>
                      <li>找到含 <code>client?_clerk_js_version</code> 的请求，复制 Cookie。</li>
                      <li>粘贴到下方（必须包含 <code>__client</code>）。</li>
                    </ol>
                  </div>
                )}

                <div className={styles.wizardForm}>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>账号名称</span>
                    <input
                      className={styles.input}
                      value={accountName}
                      onChange={(event) => setAccountName(event.target.value)}
                      placeholder={authMethod === 'password' && authEmail ? authEmail : '例如：主账号 / 备用号'}
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>加入池</span>
                    <select className={styles.select} value={accountTier} onChange={(event) => setAccountTier(event.target.value as 'basic' | 'super' | 'heavy')}>
                      <option value="basic">basic（标准）</option>
                      <option value="super">super（高容量）</option>
                      <option value="heavy">heavy（最高容量）</option>
                    </select>
                  </label>
                  <label className={`${styles.field} ${styles.fieldFull}`}>
                    <span className={styles.fieldLabel}>授权 Cookie（登录后粘贴）</span>
                    <textarea
                      className={styles.textarea}
                      value={accountCookie}
                      onChange={(event) => {
                        setAccountCookie(event.target.value);
                        setVerifyResult('');
                      }}
                      placeholder="粘贴包含 __client 的 Cookie 字符串"
                    />
                  </label>
                </div>
                {verifyResult && <div className={`${styles.notice} ${styles.noticeInfo}`} style={{ marginBottom: 0 }}><Check size={16} />{verifyResult}</div>}

                <div className={styles.advancedBox}>
                  <button className={styles.advancedToggle} type="button" onClick={() => setShowAdvancedTools((value) => !value)}>
                    <Terminal size={14} />
                    {showAdvancedTools ? '收起本机自动提取工具' : '高级：本机 suno-cookie-extractor 自动提取'}
                  </button>
                  {showAdvancedTools && (
                    <div className={styles.advancedBody}>
                      <p className={styles.hintBox}>如果你在本机开发机上运行项目，可用 Playwright 自动打开浏览器抓取 Cookie。</p>
                      <div className={styles.commandBox}>
                        <code>cd suno-cookie-extractor && npm install && cd ..</code>
                        <button className={styles.button} type="button" onClick={() => copyText('cd suno-cookie-extractor && npm install && cd ..', 'install')}>
                          <Copy size={14} />{copiedCommand === 'install' ? '已复制' : '复制'}
                        </button>
                      </div>
                      <div className={styles.commandBox}>
                        <code>{extractorCommand()}</code>
                        <button className={styles.button} type="button" onClick={() => copyText(extractorCommand(), 'cmd')}>
                          <Copy size={14} />{copiedCommand === 'cmd' ? '已复制' : '复制命令'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {authStep === 3 && (
              <div className={styles.confirmPanel}>
                <div className={styles.confirmTitle}>确认授权信息</div>
                <div className={styles.confirmGrid}>
                  <div><span>授权方式</span><strong>{authMethodLabel(authMethod)}</strong></div>
                  <div><span>账号名称</span><strong>{accountName || (authEmail.trim() || '未命名账号')}</strong></div>
                  <div><span>账号池</span><strong>{accountTier}</strong></div>
                  <div><span>Cookie</span><strong>{accountCookie.includes('__client') ? '已包含 __client' : '缺少 __client'}</strong></div>
                </div>
                {authMethod === 'password' && authEmail.trim() && (
                  <div className={styles.confirmExtra}><span>登录账号</span><strong>{authEmail.trim()}</strong></div>
                )}
                {verifyResult && <div className={`${styles.notice} ${styles.noticeInfo}`} style={{ marginTop: 14, marginBottom: 0 }}><Check size={16} />{verifyResult}</div>}
                <p className={styles.confirmNote}>点击完成授权后，系统会先校验 Cookie，再加密写入账号池并同步配额。</p>
              </div>
            )}
          </div>

          <div className={styles.modalFooter}>
            <button className={styles.button} type="button" onClick={authStep === 1 ? closeAuthWizard : () => setAuthStep((step) => (step - 1) as AuthStep)} disabled={accountBusy || verifyingCookie}>
              {authStep === 1 ? '取消' : <><ArrowLeft size={14} />上一步</>}
            </button>
            <div className={styles.modalFooterRight}>
              {authStep === 2 && (
                <button className={styles.button} type="button" onClick={verifyCookie} disabled={verifyingCookie || accountBusy || !accountCookie.trim()}>
                  <ShieldCheck size={14} />{verifyingCookie ? '校验中…' : '先校验 Cookie'}
                </button>
              )}
              {authStep < 3 ? (
                <button
                  className={`${styles.button} ${styles.buttonPrimary}`}
                  type="button"
                  onClick={() => {
                    if (authStep === 1) {
                      setError('');
                      setAuthStep(2);
                      return;
                    }
                    if (authMethod === 'password' && !authEmail.trim() && !accountCookie.trim()) {
                      setError('请先填写登录邮箱，或直接粘贴 Cookie。');
                      return;
                    }
                    if (!accountCookie.trim()) {
                      setError('请先粘贴登录后的 Cookie 再继续。');
                      return;
                    }
                    if (!accountCookie.includes('__client')) {
                      setError('Cookie 必须包含 __client。');
                      return;
                    }
                    setError('');
                    setAuthStep(3);
                  }}
                >
                  下一步 <ArrowRight size={14} />
                </button>
              ) : (
                <button className={`${styles.button} ${styles.buttonPrimary}`} type="button" onClick={verifyAndSave} disabled={accountBusy || verifyingCookie}>
                  <Check size={14} />{accountBusy || verifyingCookie ? '授权中…' : '完成授权'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderAccounts() {
    return (
      <>
        {renderPageHeader(
          '账号池',
          '管理账号授权、池级别、配额健康度与单账号并发。',
          <>
            <button className={styles.button} type="button" onClick={refreshAccounts} disabled={accountBusy || accounts.length === 0}>
              <RotateCw size={15} className={accountBusy ? styles.spin : undefined} />同步全部配额
            </button>
            <button className={`${styles.button} ${styles.buttonPrimary}`} type="button" onClick={openAuthWizard} disabled={accountBusy}>
              <Plus size={15} />添加账号
            </button>
          </>,
        )}
        <section className={styles.panel} style={{ marginTop: 0 }}>
          <div className={styles.toolbar}>
            <div className={styles.toolbarFilters}>
              <label className={styles.searchField}>
                <Search size={15} aria-hidden="true" />
                <input value={accountQuery} onChange={(event) => setAccountQuery(event.target.value)} placeholder="搜索账号名称或 ID" aria-label="搜索账号" />
                {accountQuery ? <button type="button" onClick={() => setAccountQuery('')} title="清空搜索" aria-label="清空搜索"><X size={14} /></button> : null}
              </label>
              <select className={styles.filterSelect} value={accountStatusFilter} onChange={(event) => setAccountStatusFilter(event.target.value as AccountStatusFilter)} aria-label="账号状态筛选">
                {(Object.keys(accountStatusLabels) as AccountStatusFilter[]).map((status) => <option value={status} key={status}>{accountStatusLabels[status]}</option>)}
              </select>
            </div>
            <div className={styles.toolbarBottom}>
              <div className={styles.segmented} role="tablist" aria-label="账号池筛选">
                {(Object.keys(tierLabels) as PoolFilter[]).map((filter) => (
                  <button key={filter} className={`${styles.segmentedButton} ${poolFilter === filter ? styles.segmentedButtonActive : ''}`} type="button" role="tab" aria-selected={poolFilter === filter} onClick={() => setPoolFilter(filter)}>{tierLabels[filter]} <span>{filter === 'all' ? accounts.length : poolCounts[filter]}</span></button>
                ))}
              </div>
              <span className={styles.toolbarCount}>显示 {filteredAccounts.length} / {accounts.length} 个账号</span>
            </div>
          </div>
          {filteredAccounts.length === 0
            ? <div className={styles.emptyState}><span className={styles.emptyIcon}><UsersRound size={19} /></span><span className={styles.emptyTitle}>{accounts.length === 0 ? '还没有账号' : '没有匹配的账号'}</span><span className={styles.emptyText}>{accounts.length === 0 ? '点击「添加账号」，通过浏览器插件、授权链接或 Cookie 完成授权。' : '调整池级别、状态或搜索条件后重试。'}</span></div>
            : <div className={styles.accountTable} role="table" aria-label="账号池列表">
              <div className={styles.accountHeader} role="row"><span role="columnheader">账号</span><span role="columnheader">池级别</span><span role="columnheader">配额</span><span role="columnheader">健康度</span><span role="columnheader">状态</span><span role="columnheader">并发</span><span role="columnheader">操作</span></div>
              {filteredAccounts.map(renderAccountRow)}
            </div>}
        </section>
      </>
    );
  }

  function renderGenerate() {
    return (
      <>
        {renderPageHeader(
          '音乐生成',
          '提交一条音乐任务，系统会按池级别和当前负载选择账号。',
          <button className={styles.button} type="button" onClick={() => switchView('tasks')}><ListMusic size={15} />查看任务记录</button>,
        )}
        <div className={styles.generateGrid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div><h2 className={styles.panelTitle}>新建任务</h2><p className={styles.panelDescription}>支持提示词和纯音乐模式</p></div>
              <span className={`${styles.badge} ${styles.badgeGreen}`}><Check size={13} />接口可用</span>
            </div>
            <form className={styles.generateForm} onSubmit={generate}>
              <label className={styles.field}><span className={styles.fieldLabel}>提示词 <span className={styles.fieldHint}>描述风格、情绪、乐器和节奏</span></span><textarea className={styles.textarea} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：夜晚城市街头的爵士鼓点，温暖的电钢琴，适合专注工作的器乐曲…" /></label>
              <div className={styles.generateOptions}>
                <label className={styles.field}><span className={styles.fieldLabel}>生成模型</span><select className={styles.select} value={generationModel} onChange={(event) => setGenerationModel(event.target.value)}>{SUNO_MODEL_CATALOG.map((model) => <option value={model.id} key={model.id}>{model.label}{model.recommended ? '（推荐）' : model.status === 'current' ? '（最新）' : model.status === 'legacy' ? '（旧版）' : ''}</option>)}</select></label>
                <label className={styles.field}><span className={styles.fieldLabel}>优先池级别</span><select className={styles.select} value={generationPool} onChange={(event) => setGenerationPool(event.target.value as 'basic' | 'super' | 'heavy')}><option value="basic">basic（标准）</option><option value="super">super（高容量）</option><option value="heavy">heavy（最高容量）</option></select></label>
                <label className={styles.checkboxLabel}><input className={styles.checkbox} type="checkbox" checked={instrumental} onChange={(event) => setInstrumental(event.target.checked)} />纯音乐</label>
              </div>
              <button className={`${styles.button} ${styles.buttonPrimary} ${styles.generateButton}`} type="submit" disabled={busy || accounts.length === 0}><WandSparkles size={15} />{busy ? '提交中…' : '提交生成任务'}</button>
              {accounts.length === 0 && <div className={styles.loginError}>请先在账号池中添加可用账号。</div>}
            </form>
          </section>
          <div className={styles.sideStack}>
            <section className={styles.panel}>
              <div className={styles.panelHeader}><div><h2 className={styles.panelTitle}>池容量</h2><p className={styles.panelDescription}>选择优先级，必要时自动降级</p></div></div>
              <div className={styles.poolChoiceList}>
                {(['basic', 'super', 'heavy'] as const).map((tier) => {
                  const tierAccounts = accounts.filter((account) => account.tier === tier);
                  const available = tierAccounts.filter((account) => account.enabled && account.status === 'active').length;
                  return <button type="button" key={tier} className={`${styles.poolChoice} ${generationPool === tier ? styles.poolChoiceActive : ''}`} onClick={() => setGenerationPool(tier)}><span><strong>{tier}</strong><small>{available} / {tierAccounts.length} 可用</small></span><ChevronRight size={15} /></button>;
                })}
              </div>
            </section>
            <section className={styles.panel}>
              <div className={styles.panelHeader}><div><h2 className={styles.panelTitle}>请求信息</h2><p className={styles.panelDescription}>生成接口的当前连接状态</p></div></div>
              <div className={styles.detailList}>
                <div><span>接口地址</span><code>{apiEndpoint}</code></div>
                <div><span>生成模型</span><code>{generationModel}</code></div>
                <div><span>当前账号</span><strong>{activeAccounts} 个可用</strong></div>
                <div><span>预计计费</span><strong>{billingPreview.valid ? `${formatQuantity(billingPreview.billingPointsPerGeneration)} 积分 / ${formatQuantity(billingPreview.outputsPerGeneration, 0)} 首` : '--'}</strong></div>
                <div><span>自动刷新</span><strong>每 15 秒</strong></div>
              </div>
            </section>
          </div>
        </div>
      </>
    );
  }

  function renderTasks() {
    return (
      <>
        {renderPageHeader(
          '任务记录',
          '查看生成任务的状态、提示词和音频结果。',
          <button className={`${styles.button} ${styles.buttonPrimary}`} type="button" onClick={() => switchView('generate')}><WandSparkles size={15} />新建生成任务</button>,
        )}
        <section className={styles.panel}>
          <div className={styles.taskToolbar}>
            <div className={styles.segmented} role="tablist" aria-label="任务状态筛选">
              {(Object.keys(taskFilterLabels) as TaskFilter[]).map((filter) => (
                <button key={filter} className={`${styles.segmentedButton} ${taskFilter === filter ? styles.segmentedButtonActive : ''}`} type="button" role="tab" aria-selected={taskFilter === filter} onClick={() => { setTaskFilter(filter); setTaskPage(1); }}>{taskFilterLabels[filter]} <span>{taskCounts[filter]}</span></button>
              ))}
            </div>
            <label className={styles.searchField}>
              <Search size={15} aria-hidden="true" />
              <input value={taskQuery} onChange={(event) => { setTaskQuery(event.target.value); setTaskPage(1); }} placeholder="搜索标题、提示词或任务 ID" aria-label="搜索任务" />
              {taskQuery ? <button type="button" onClick={() => { setTaskQuery(''); setTaskPage(1); }} title="清空搜索" aria-label="清空搜索"><X size={14} /></button> : null}
            </label>
          </div>
          {visibleSongs.length === 0
            ? <div className={styles.emptyState}><span className={styles.emptyIcon}><Music2 size={19} /></span><span className={styles.emptyTitle}>{songs.length === 0 ? '暂无生成任务' : '没有匹配的任务'}</span><span className={styles.emptyText}>{songs.length === 0 ? '提交任务后，状态和音频会显示在这里。' : '调整状态或搜索条件后重试。'}</span></div>
            : <div className={styles.taskList}>{visibleSongs.map((song) => renderTaskRow(song, true))}</div>}
          {filteredSongs.length > TASKS_PER_PAGE ? (
            <div className={styles.pagination}>
              <span>第 {currentTaskPage} / {totalTaskPages} 页，共 {filteredSongs.length} 条</span>
              <div className={styles.paginationButtons}>
                <button className={styles.iconButton} type="button" onClick={() => setTaskPage((page) => Math.max(1, page - 1))} disabled={currentTaskPage === 1} aria-label="上一页" title="上一页"><ChevronLeft size={16} /></button>
                <button className={styles.iconButton} type="button" onClick={() => setTaskPage((page) => Math.min(totalTaskPages, page + 1))} disabled={currentTaskPage === totalTaskPages} aria-label="下一页" title="下一页"><ChevronRight size={16} /></button>
              </div>
            </div>
          ) : null}
        </section>
      </>
    );
  }

  function renderModels() {
    const discoveryCommand = `curl "${apiEndpoint}/models" -H "Authorization: Bearer $API_KEY"`;
    return (
      <>
        {renderPageHeader(
          '模型目录',
          '下游客户端可通过 OpenAI 兼容接口自动发现这些模型。',
          <button className={styles.button} type="button" onClick={() => copyText(`${apiEndpoint}/models`, 'models-endpoint')}>
            {copiedCommand === 'models-endpoint' ? <CopyCheck size={15} /> : <Copy size={15} />}
            {copiedCommand === 'models-endpoint' ? '已复制' : '复制模型地址'}
          </button>,
        )}
        <div className={styles.modelCatalogLayout}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div><h2 className={styles.panelTitle}>可调用模型</h2><p className={styles.panelDescription}>目录与 `/v1/models` 返回值保持一致</p></div>
              <span className={`${styles.badge} ${styles.badgeGreen}`}>{SUNO_MODEL_CATALOG.length} 个模型</span>
            </div>
            <div className={styles.modelTable} role="table" aria-label="Suno 模型目录">
              <div className={styles.modelTableHeader} role="row">
                <span role="columnheader">模型 ID</span>
                <span role="columnheader">类型</span>
                <span role="columnheader">上游映射</span>
                <span role="columnheader">状态</span>
              </div>
              {SUNO_MODEL_CATALOG.map((model) => (
                <div className={styles.modelTableRow} role="row" key={model.id}>
                  <div className={styles.modelIdentity} role="cell">
                    <span className={styles.modelIcon}><Boxes size={16} /></span>
                    <span><code>{model.id}</code><small>{modelDescriptions[model.id] || model.description}</small></span>
                  </div>
                  <div className={styles.modelCell} role="cell"><span className={styles.mobileFieldLabel}>类型</span><strong>{model.id === model.providerModel ? '上游模型' : '兼容别名'}</strong></div>
                  <div className={styles.modelCell} role="cell"><span className={styles.mobileFieldLabel}>上游映射</span><code>{model.providerModel}</code></div>
                  <div className={styles.modelCell} role="cell"><span className={styles.mobileFieldLabel}>状态</span><span className={`${styles.badge} ${model.recommended || model.status === 'current' ? styles.badgeGreen : model.status === 'legacy' ? styles.badgeAmber : styles.badgeBlue}`}>{model.recommended ? '推荐' : model.status === 'current' ? '最新' : model.status === 'legacy' ? '旧版' : '稳定'}</span></div>
                </div>
              ))}
            </div>
          </section>
          <aside className={`${styles.panel} ${styles.modelDiscoveryPanel}`}>
            <div className={styles.panelHeader}><div><h2 className={styles.panelTitle}>下游发现</h2><p className={styles.panelDescription}>兼容 OpenAI Models API</p></div></div>
            <div className={styles.panelBody}>
              <button className={styles.endpointCopyRow} type="button" onClick={() => copyText(`${apiEndpoint}/models`, 'models-list')}>
                <Terminal size={15} /><code>{apiEndpoint}/models</code>{copiedCommand === 'models-list' ? <CopyCheck size={15} /> : <Copy size={15} />}
              </button>
              <div className={styles.commandBlock}>
                <code>{discoveryCommand}</code>
                <button className={styles.iconButton} type="button" title="复制请求命令" aria-label="复制模型列表请求命令" onClick={() => copyText(discoveryCommand, 'models-curl')}>
                  {copiedCommand === 'models-curl' ? <CopyCheck size={15} /> : <Copy size={15} />}
                </button>
              </div>
              <div className={styles.integrationNote}>
                <strong>客户端配置</strong>
                <div><span>推荐模型</span><code>{DEFAULT_OPENAI_MODEL}</code></div>
                <div><span>列表接口</span><code>GET /v1/models</code></div>
                <div><span>单个模型</span><code>GET /v1/models/{'{model}'}</code></div>
              </div>
              <p className={styles.settingsHint}>未知的非空模型名称仍会透传给 Suno，便于兼容上游后续新增版本；模型目录只列出当前已确认的选项。</p>
            </div>
          </aside>
        </div>
      </>
    );
  }

  if (configured === null) {
    return <div className={styles.checkingRoot}><RefreshCw size={19} className={styles.spin} />正在检查管理权限…</div>;
  }

  if (!authenticated) {
    return (
      <main className={styles.loginRoot}>
        <section className={styles.loginCard}>
          <div className={styles.loginBrand}><span className={styles.brandMark}><Music2 size={17} /></span><span className={styles.loginBrandText}>SUNO API 管理后台</span></div>
          <div className={styles.loginBody}>
            <h1 className={styles.loginTitle}>登录管理后台</h1>
            <p className={styles.loginSubtitle}>查看账号池、配额和生成任务。</p>
            {!configured ? <div className={styles.configWarning}>服务器尚未配置 ADMIN_PASSWORD，请在 `.env` 中设置后重启服务。</div> : (
              <form onSubmit={login}>
                <label className={styles.field}><span className={styles.fieldLabel}>管理密码</span><input className={styles.input} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
                {loginError && <p className={styles.loginError}>{loginError}</p>}
                <button className={`${styles.button} ${styles.buttonPrimary} ${styles.loginButton}`} type="submit"><KeyRound size={15} />进入后台</button>
              </form>
            )}
          </div>
        </section>
      </main>
    );
  }


  async function refreshCaptchaStatus() {
    setCaptchaLoading(true);
    try {
      const response = await fetch('/api/admin/captcha', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '读取验证码配置失败');
      setCaptchaStatus(data);
      setCaptchaForm((prev) => ({
        ...prev,
        provider: data.providerSetting || (data.provider === 'none' ? 'auto' : data.provider) || 'auto',
        captchaMode: data.captchaMode || 'auto',
        yescaptchaBaseUrl: data.yescaptchaBaseUrl || 'https://api.yescaptcha.com',
      }));
      setMessage('验证码配置已刷新');
    } catch (err: any) {
      setError(err?.message || '读取验证码配置失败');
    } finally {
      setCaptchaLoading(false);
    }
  }

  async function saveCaptchaSettings(event: FormEvent) {
    event.preventDefault();
    setCaptchaSaving(true);
    setError('');
    setMessage('');
    try {
      const payload: Record<string, string> = {
        provider: captchaForm.provider,
        captchaMode: captchaForm.captchaMode,
        yescaptchaBaseUrl: captchaForm.yescaptchaBaseUrl,
      };
      // Only send keys when user typed a new value; empty means keep existing on server if we send undefined.
      // Explicit blank with placeholder note: if user clears and wants to keep, they leave blank; to clear key they type CLEAR.
      if (captchaForm.yescaptchaKey.trim()) {
        payload.yescaptchaKey = captchaForm.yescaptchaKey.trim() === 'CLEAR' ? '' : captchaForm.yescaptchaKey.trim();
      }
      if (captchaForm.twocaptchaKey.trim()) {
        payload.twocaptchaKey = captchaForm.twocaptchaKey.trim() === 'CLEAR' ? '' : captchaForm.twocaptchaKey.trim();
      }
      // If provider requires keys already configured, allow save of provider-only changes
      if (!captchaForm.yescaptchaKey.trim() && !captchaForm.twocaptchaKey.trim()) {
        // still allow provider/mode/baseUrl save by reusing current keys through server merge
      }
      const response = await fetch('/api/admin/captcha', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: captchaForm.provider,
          captchaMode: captchaForm.captchaMode,
          yescaptchaBaseUrl: captchaForm.yescaptchaBaseUrl,
          ...(captchaForm.yescaptchaKey.trim()
            ? { yescaptchaKey: captchaForm.yescaptchaKey.trim() === 'CLEAR' ? '' : captchaForm.yescaptchaKey.trim() }
            : {}),
          ...(captchaForm.twocaptchaKey.trim()
            ? { twocaptchaKey: captchaForm.twocaptchaKey.trim() === 'CLEAR' ? '' : captchaForm.twocaptchaKey.trim() }
            : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存失败');
      setCaptchaStatus(data.status || data);
      setCaptchaForm((prev) => ({ ...prev, yescaptchaKey: '', twocaptchaKey: '' }));
      setMessage(data.message || '验证码配置已保存');
      await refreshCaptchaStatus();
    } catch (err: any) {
      setError(err?.message || '保存验证码配置失败');
    } finally {
      setCaptchaSaving(false);
    }
  }

  async function probeCaptchaProviders() {
    setCaptchaProbeLoading(true);
    try {
      const response = await fetch('/api/admin/captcha/probe', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '验证码服务连通检测失败');
      setCaptchaStatus((current) => current ? {
        ...current,
        network: data.network || current.network,
        providers: Object.fromEntries(Object.entries(current.providers || {}).map(([name, value]) => [
          name,
          { ...value, api: data.providers?.[name]?.api || value.api },
        ])),
      } : current);
      setMessage('验证码服务 API 连通检测已完成');
    } catch (err: any) {
      setError(err?.message || '验证码服务连通检测失败');
    } finally {
      setCaptchaProbeLoading(false);
    }
  }

  async function refreshApiKeyStatus() {
    setApiKeyLoading(true);
    try {
      const response = await fetch('/api/admin/apikey', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '读取接口密钥失败');
      setApiKeyStatus(data);
      setApiKeyForm((prev) => ({ ...prev, enabled: Boolean(data.enabled) }));
    } catch (err: any) {
      setError(err?.message || '读取接口密钥失败');
    } finally {
      setApiKeyLoading(false);
    }
  }

  async function saveApiKeySettings(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setApiKeySaving(true);
    setError('');
    setMessage('');
    try {
      const payload: any = { enabled: apiKeyForm.enabled };
      if (apiKeyForm.apiKey.trim()) payload.apiKey = apiKeyForm.apiKey.trim();
      const response = await fetch('/api/admin/apikey', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存接口密钥失败');
      if (data.apiKey) setApiKeyPlain(data.apiKey);
      setApiKeyForm((prev) => ({ ...prev, apiKey: '' }));
      setApiKeyStatus(data.status || data);
      setMessage(data.message || '接口密钥已保存');
      await refreshApiKeyStatus();
    } catch (err: any) {
      setError(err?.message || '保存接口密钥失败');
    } finally {
      setApiKeySaving(false);
    }
  }

  async function generateNewApiKey() {
    setApiKeySaving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/admin/apikey', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generate: true, enabled: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '生成接口密钥失败');
      if (data.apiKey) setApiKeyPlain(data.apiKey);
      setApiKeyStatus(data.status || data);
      setApiKeyForm((prev) => ({ ...prev, enabled: true, apiKey: '' }));
      setMessage('已生成新密钥，请立即复制保存。');
    } catch (err: any) {
      setError(err?.message || '生成接口密钥失败');
    } finally {
      setApiKeySaving(false);
    }
  }

  async function refreshBillingSettings() {
    setBillingLoading(true);
    setError('');
    try {
      const response = await fetch('/api/admin/billing', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '读取计费配置失败');
      setBillingForm(toBillingForm(data.settings));
      setBillingUpdatedAt(data.settings?.updatedAt);
      billingDirtyRef.current = false;
      setMessage('计费配置已刷新');
    } catch (err: any) {
      setError(err?.message || '读取计费配置失败');
    } finally {
      setBillingLoading(false);
    }
  }

  async function saveBillingSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!billingPreview.valid) {
      setError('计费参数必须全部为大于 0 的数字。');
      return;
    }

    setBillingSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/admin/billing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          purchaseCostCny: Number(billingForm.purchaseCostCny),
          purchasedCredits: Number(billingForm.purchasedCredits),
          creditsPerGeneration: Number(billingForm.creditsPerGeneration),
          outputsPerGeneration: Number(billingForm.outputsPerGeneration),
          rateMultiplier: Number(billingForm.rateMultiplier),
          cnyPerUsd: Number(billingForm.cnyPerUsd),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存计费配置失败');
      setBillingForm(toBillingForm(data.settings));
      setBillingUpdatedAt(data.settings?.updatedAt);
      billingDirtyRef.current = false;
      setMessage(data.message || '计费配置已保存');
    } catch (err: any) {
      setError(err?.message || '保存计费配置失败');
    } finally {
      setBillingSaving(false);
    }
  }

  async function refreshConcurrencySettings() {
    setConcurrencyLoading(true);
    setError('');
    try {
      const response = await fetch('/api/admin/concurrency', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '读取并发配置失败');
      setConcurrencyStatus(data);
      setConcurrencyLimit(String(data.settings?.maxConcurrentRequests ?? 4));
      concurrencyDirtyRef.current = false;
      setMessage('并发配置已刷新');
    } catch (err: any) {
      setError(err?.message || '读取并发配置失败');
    } finally {
      setConcurrencyLoading(false);
    }
  }

  async function saveConcurrencySettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const maxConcurrentRequests = Number(concurrencyLimit);
    if (!Number.isInteger(maxConcurrentRequests) || maxConcurrentRequests < 1 || maxConcurrentRequests > 100) {
      setError('最大并发请求数必须是 1 到 100 之间的整数。');
      return;
    }

    setConcurrencySaving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/admin/concurrency', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxConcurrentRequests }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存并发配置失败');
      setConcurrencyStatus(data);
      setConcurrencyLimit(String(data.settings?.maxConcurrentRequests ?? maxConcurrentRequests));
      concurrencyDirtyRef.current = false;
      setMessage(data.message || '并发配置已保存');
    } catch (err: any) {
      setError(err?.message || '保存并发配置失败');
    } finally {
      setConcurrencySaving(false);
    }
  }

  function renderConcurrency() {
    const savedLimit = Math.max(1, Number(concurrencyStatus?.settings.maxConcurrentRequests) || 4);
    const activeRequests = Math.max(0, Number(concurrencyStatus?.activeRequests) || 0);
    const availableSlots = Math.max(0, Number(concurrencyStatus?.availableSlots) || 0);
    const utilization = Math.min(100, Math.round((activeRequests / savedLimit) * 100));
    const inputValue = Number(concurrencyLimit);
    const validInput = Number.isInteger(inputValue) && inputValue >= 1 && inputValue <= 100;
    const capacityTone = utilization >= 100 ? styles.badgeRed : utilization >= 75 ? styles.badgeAmber : styles.badgeGreen;
    const updateLimit = (value: string) => {
      concurrencyDirtyRef.current = true;
      setConcurrencyLimit(value);
    };

    return (
      <>
        {renderPageHeader(
          '并发控制',
          '设置音乐生成接口可同时处理的请求数量，并查看当前实时占用。',
          <button className={styles.button} type="button" onClick={refreshConcurrencySettings} disabled={concurrencyLoading}>
            <RefreshCw size={14} className={concurrencyLoading ? styles.spin : undefined} />
            {concurrencyLoading ? '刷新中…' : '刷新状态'}
          </button>,
        )}
        <div className={styles.settingsLayout}>
          <aside className={styles.settingsSummary}>
            <div className={styles.settingsSummaryIcon}><Gauge size={19} /></div>
            <h2>当前请求容量</h2>
            <p>实时数据来自服务端并发计数器。</p>
            <div className={styles.settingsStatusList}>
              <div className={styles.settingsStatusRow}><span>正在处理</span><strong>{formatQuantity(activeRequests, 0)}</strong></div>
              <div className={styles.settingsStatusRow}><span>并发上限</span><strong>{formatQuantity(savedLimit, 0)}</strong></div>
              <div className={styles.settingsStatusRow}><span>可用槽位</span><strong>{formatQuantity(availableSlots, 0)}</strong></div>
              <div className={styles.settingsStatusRow}><span>占用比例</span><strong>{utilization}%</strong></div>
            </div>
            <p className={styles.settingsHint}>
              {availableSlots > 0 ? `当前还可接收 ${formatQuantity(availableSlots, 0)} 个生成请求。` : '当前并发容量已用完。'}
            </p>
          </aside>

          <section className={`${styles.panel} ${styles.settingsMain}`}>
            <div className={styles.panelHeader}>
              <div><h2 className={styles.panelTitle}>请求并发上限</h2><p className={styles.panelDescription}>输入 1 到 100 之间的整数，保存后由服务端立即应用。</p></div>
              <span className={`${styles.badge} ${capacityTone}`}>{formatQuantity(activeRequests, 0)} / {formatQuantity(savedLimit, 0)} 使用中</span>
            </div>
            <div className={styles.panelBody}>
              <form className={styles.settingsForm} onSubmit={saveConcurrencySettings}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>最大并发请求数 <span className={styles.fieldHint}>范围 1-100</span></span>
                  <input
                    className={styles.input}
                    type="number"
                    min="1"
                    max="100"
                    step="1"
                    inputMode="numeric"
                    value={concurrencyLimit}
                    onChange={(event) => updateLimit(event.target.value)}
                  />
                </label>

                <div className={styles.billingMultiplierRow}>
                  <span>快捷设置</span>
                  <div className={styles.segmented} role="group" aria-label="快速选择最大并发请求数">
                    {[1, 2, 4, 8].map((value) => (
                      <button
                        className={`${styles.segmentedButton} ${inputValue === value ? styles.segmentedButtonActive : ''}`}
                        type="button"
                        key={value}
                        aria-pressed={inputValue === value}
                        onClick={() => updateLimit(String(value))}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.buttonRow}>
                  <button className={`${styles.button} ${styles.buttonPrimary}`} type="submit" disabled={concurrencySaving || !validInput}>
                    <Check size={15} />{concurrencySaving ? '保存中…' : '保存并发上限'}
                  </button>
                  <span className={styles.billingSavedAt}>更新：{formatDate(concurrencyStatus?.settings.updatedAt)}</span>
                </div>
              </form>

              <div className={styles.billingResults}>
                <div className={styles.billingResultsHeader}>
                  <div><strong>实时占用</strong><span>活动请求 / 当前上限</span></div>
                  <span className={`${styles.badge} ${capacityTone}`}>{utilization}%</span>
                </div>
                <div
                  className={styles.progressTrack}
                  role="progressbar"
                  aria-label="并发占用比例"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={utilization}
                >
                  <div className={styles.progressFill} style={{ width: `${utilization}%` }} />
                </div>
              </div>

              <div className={styles.helpBox}>
                <div className={styles.helpTitle}>生效范围</div>
                <div className={styles.helpText}>此上限统一控制音乐生成、续写、歌词和分轨等生成类请求。活动数和可用槽位会随后台刷新自动更新。</div>
              </div>
            </div>
          </section>
        </div>
      </>
    );
  }

  function renderBilling() {
    const preview = billingPreview;
    const multiplierBelowCost = preview.valid && preview.rateMultiplier < 1;
    const updateField = (field: keyof BillingForm, value: string) => {
      billingDirtyRef.current = true;
      setBillingForm((current) => ({ ...current, [field]: value }));
    };

    return (
      <>
        {renderPageHeader(
          '计费设置',
          '按购入成本和上游积分计算固定请求价、积分扣除与分组倍率。',
          <button className={styles.button} type="button" onClick={refreshBillingSettings} disabled={billingLoading}>
            <RefreshCw size={14} className={billingLoading ? styles.spin : undefined} />
            {billingLoading ? '刷新中…' : '刷新配置'}
          </button>,
        )}
        <div className={styles.settingsLayout}>
          <aside className={styles.settingsSummary}>
            <div className={styles.settingsSummaryIcon}><Calculator size={19} /></div>
            <h2>当前计费基准</h2>
            <p>按固定上游积分计算每次请求成本与下游扣分。</p>
            <div className={styles.settingsStatusList}>
              <div className={styles.settingsStatusRow}><span>购入成本</span><strong>{preview.valid ? formatMoney(Number(billingForm.purchaseCostCny), '¥', 2) : '--'}</strong></div>
              <div className={styles.settingsStatusRow}><span>购入积分</span><strong>{preview.valid ? formatQuantity(Number(billingForm.purchasedCredits)) : '--'}</strong></div>
              <div className={styles.settingsStatusRow}><span>单次实际成本</span><strong>{preview.valid ? formatMoney(preview.costPerGenerationCny, '¥', 4) : '--'}</strong></div>
              <div className={styles.settingsStatusRow}><span>计费倍率</span><strong className={multiplierBelowCost ? styles.textWarning : styles.textSuccess}>{preview.valid ? `${formatQuantity(preview.rateMultiplier)}x` : '--'}</strong></div>
              <div className={styles.settingsStatusRow}><span>单次扣除</span><strong>{preview.valid ? `${formatQuantity(preview.billingPointsPerGeneration)} 积分` : '--'}</strong></div>
              <div className={styles.settingsStatusRow}><span>整包产能</span><strong>{preview.valid ? `${formatQuantity(preview.generationsPerPackage, 0)} 次 / ${formatQuantity(preview.outputsPerPackage, 0)} 首` : '--'}</strong></div>
            </div>
            <p className={`${styles.settingsHint} ${multiplierBelowCost ? styles.billingWarningText : ''}`}>
              {multiplierBelowCost
                ? '当前倍率低于 1.0，倍率后参考收入低于成本基准。'
                : `倍率后整包参考合计 ${preview.valid ? formatMoney(preview.referencePackageValueCny, '¥', 2) : '--'}。`}
            </p>
          </aside>

          <section className={`${styles.panel} ${styles.settingsMain}`}>
            <div className={styles.panelHeader}>
              <div><h2 className={styles.panelTitle}>积分与倍率</h2><p className={styles.panelDescription}>保存后写入服务器，前端计算结果会同步更新。</p></div>
              <span className={`${styles.badge} ${multiplierBelowCost ? styles.badgeAmber : styles.badgeGreen}`}>{preview.valid ? `${formatQuantity(preview.billingPointsPerGeneration)} 积分 / 次` : '参数不完整'}</span>
            </div>
            <div className={styles.panelBody}>
              <form className={styles.settingsForm} onSubmit={saveBillingSettings}>
                <div className={styles.formGridTwo}>
                  <label className={styles.field}><span className={styles.fieldLabel}>购入成本（元）</span><input className={styles.input} type="number" min="0.01" step="0.01" value={billingForm.purchaseCostCny} onChange={(event) => updateField('purchaseCostCny', event.target.value)} /></label>
                  <label className={styles.field}><span className={styles.fieldLabel}>购入上游积分</span><input className={styles.input} type="number" min="1" step="1" value={billingForm.purchasedCredits} onChange={(event) => updateField('purchasedCredits', event.target.value)} /></label>
                  <label className={styles.field}><span className={styles.fieldLabel}>每次消耗积分</span><input className={styles.input} type="number" min="0.01" step="0.01" value={billingForm.creditsPerGeneration} onChange={(event) => updateField('creditsPerGeneration', event.target.value)} /></label>
                  <label className={styles.field}><span className={styles.fieldLabel}>每次产出歌曲</span><input className={styles.input} type="number" min="1" step="1" value={billingForm.outputsPerGeneration} onChange={(event) => updateField('outputsPerGeneration', event.target.value)} /></label>
                  <label className={styles.field}><span className={styles.fieldLabel}>分组计费倍率</span><input className={styles.input} type="number" min="0.01" step="0.05" value={billingForm.rateMultiplier} onChange={(event) => updateField('rateMultiplier', event.target.value)} /></label>
                  <label className={styles.field}><span className={styles.fieldLabel}>余额换算比例（当前 1:1）</span><input className={styles.input} type="number" min="0.01" step="0.01" value={billingForm.cnyPerUsd} onChange={(event) => updateField('cnyPerUsd', event.target.value)} /></label>
                </div>

                <div className={styles.billingMultiplierRow}>
                  <span>快速倍率</span>
                  <div className={styles.segmented} role="group" aria-label="快速选择计费倍率">
                    {[1, 1.2, 1.5, 2].map((value) => (
                      <button
                        className={`${styles.segmentedButton} ${Number(billingForm.rateMultiplier) === value ? styles.segmentedButtonActive : ''}`}
                        type="button"
                        key={value}
                        onClick={() => updateField('rateMultiplier', String(value))}
                      >
                        {value.toFixed(1)}x
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.buttonRow}>
                  <button className={`${styles.button} ${styles.buttonPrimary}`} type="submit" disabled={billingSaving || !preview.valid}>
                    <Check size={15} />{billingSaving ? '保存中…' : '保存计费设置'}
                  </button>
                  <span className={styles.billingSavedAt}>更新：{formatDate(billingUpdatedAt)}</span>
                </div>
              </form>

              <div className={styles.billingResults}>
                <div className={styles.billingResultsHeader}>
                  <div><strong>实时计算</strong><span>按当前输入值预览</span></div>
                  <span className={`${styles.badge} ${multiplierBelowCost ? styles.badgeAmber : styles.badgeBlue}`}>
                    毛利率 {preview.valid ? `${formatQuantity(preview.grossMarginPercent, 1)}%` : '--'}
                  </span>
                </div>
                <div className={styles.billingMetricGrid}>
                  <div className={styles.billingMetric}><span>单积分成本</span><strong>{preview.valid ? formatMoney(preview.costPerCreditCny, '¥', 4) : '--'}</strong><small>{preview.valid ? `${formatQuantity(Number(billingForm.purchaseCostCny))} ÷ ${formatQuantity(Number(billingForm.purchasedCredits))}` : '--'}</small></div>
                  <div className={styles.billingMetric}><span>单次实际成本</span><strong>{preview.valid ? formatMoney(preview.costPerGenerationCny, '¥', 4) : '--'}</strong><small>{formatQuantity(Number(billingForm.creditsPerGeneration))} 上游积分</small></div>
                  <div className={styles.billingMetric}><span>每首实际成本</span><strong>{preview.valid ? formatMoney(preview.costPerOutputCny, '¥', 4) : '--'}</strong><small>{formatQuantity(preview.outputsPerGeneration, 0)} 首 / 次</small></div>
                  <div className={styles.billingMetric}><span>倍率后单次积分</span><strong>{preview.valid ? formatQuantity(preview.billingPointsPerGeneration) : '--'}</strong><small>{preview.valid ? `${formatQuantity(preview.billingPointsPerOutput)} 积分 / 首` : '--'}</small></div>
                  <div className={styles.billingMetric}><span>整包可售积分</span><strong>{preview.valid ? formatQuantity(preview.totalBillablePoints) : '--'}</strong><small>上游积分 × 倍率</small></div>
                  <div className={styles.billingMetric}><span>倍率后单次参考价</span><strong>{preview.valid ? formatMoney(preview.referenceGenerationValueCny, '¥', 4) : '--'}</strong><small>实际成本 × 倍率</small></div>
                  <div className={styles.billingMetric}><span>Sub2API 固定价</span><strong>{preview.valid ? formatMoney(preview.sub2apiPerRequestPriceUsd, '$', 6) : '--'}</strong><small>per_request_price</small></div>
                  <div className={styles.billingMetric}><span>倍率后实际计费</span><strong>{preview.valid ? formatMoney(preview.sub2apiEffectivePriceUsd, '$', 6) : '--'}</strong><small>固定价 × 分组倍率</small></div>
                </div>
              </div>

              <div className={styles.integrationNote}>
                <strong>Sub2API 渠道计费</strong>
                <div><span>billing_mode</span><code>per_request</code></div>
                <div><span>per_request_price</span><code>{preview.valid ? preview.sub2apiPerRequestPriceUsd.toFixed(6) : '--'}</code></div>
                <div><span>分组倍率</span><code>{preview.valid ? preview.rateMultiplier.toFixed(2) : '--'}</code></div>
                <div><span>余额换算口径</span><code>1 美元余额单位 = {formatQuantity(Number(billingForm.cnyPerUsd))} 元成本</code></div>
              </div>
            </div>
          </section>
        </div>
      </>
    );
  }

  function renderApiKey() {
    const status = apiKeyStatus;
    return (
      <>
        {renderPageHeader(
          '接口密钥',
          '控制 OpenAI 兼容接口的访问方式，供 sub2api 和其他客户端使用。',
          <button className={styles.button} type="button" onClick={refreshApiKeyStatus} disabled={apiKeyLoading}><RefreshCw size={14} className={apiKeyLoading ? styles.spin : undefined} />{apiKeyLoading ? '刷新中…' : '刷新状态'}</button>,
        )}
        <div className={styles.settingsLayout}>
          <aside className={styles.settingsSummary}>
            <div className={styles.settingsSummaryIcon}><KeyRound size={19} /></div>
            <h2>接入状态</h2>
            <p>客户端调用时使用下方地址和密钥。</p>
            <div className={styles.settingsStatusList}>
              <div className={styles.settingsStatusRow}><span>鉴权</span><strong className={status?.enabled ? styles.textSuccess : styles.textWarning}>{status?.enabled ? '已启用' : '开放访问'}</strong></div>
              <div className={styles.settingsStatusRow}><span>密钥</span><strong>{status?.apiKeyMasked || '未配置'}</strong></div>
              <div className={styles.settingsStatusRow}><span>更新</span><strong>{formatDate(status?.updatedAt)}</strong></div>
            </div>
            <button className={styles.endpointCopyRow} type="button" onClick={() => copyText(apiEndpoint, 'api-base')}><Terminal size={15} /><code>{apiEndpoint}</code>{copiedCommand === 'api-base' ? <CopyCheck size={15} /> : <Copy size={15} />}</button>
            <p className={styles.settingsHint}>Base URL 以 `/v1` 结尾；下游可通过 `/v1/models` 自动读取模型目录。</p>
          </aside>
          <section className={`${styles.panel} ${styles.settingsMain}`}>
            <div className={styles.panelHeader}><div><h2 className={styles.panelTitle}>配置 API Key</h2><p className={styles.panelDescription}>留空保留当前密钥，输入 CLEAR 可清空。</p></div></div>
            <div className={styles.panelBody}>
              {apiKeyPlain ? (
                <div className={styles.secretNotice}>
                  <div><strong>新密钥已生成</strong><span>只显示这一次，请立即复制并保存。</span></div>
                  <div className={styles.secretValueRow}><code>{apiKeyPlain}</code><button className={styles.button} type="button" onClick={() => copyText(apiKeyPlain, 'api-key')}><Copy size={14} />复制</button></div>
                </div>
              ) : null}
              <form className={styles.settingsForm} onSubmit={saveApiKeySettings}>
                <label className={styles.switchRow}><input type="checkbox" checked={apiKeyForm.enabled} onChange={(e) => setApiKeyForm((prev) => ({ ...prev, enabled: e.target.checked }))} /><span><strong>启用 API Key 鉴权</strong><small>调用 `/v1/chat/completions`、`/v1/responses` 等接口时必须携带 Bearer Token。</small></span></label>
                <div className={`${styles.field} ${styles.fieldFull}`}><div className={styles.fieldLabel}>自定义密钥</div><div className={styles.passwordField}><input className={styles.input} type={apiKeyForm.showKey ? 'text' : 'password'} value={apiKeyForm.apiKey} onChange={(e) => setApiKeyForm((prev) => ({ ...prev, apiKey: e.target.value }))} placeholder={status?.apiKeyMasked ? `当前 ${status.apiKeyMasked}` : 'sk-suno-...'} autoComplete="off" /><button className={styles.iconButton} type="button" onClick={() => setApiKeyForm((prev) => ({ ...prev, showKey: !prev.showKey }))} aria-label={apiKeyForm.showKey ? '隐藏密钥' : '显示密钥'}>{apiKeyForm.showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></div>
                <div className={styles.buttonRow}><button className={`${styles.button} ${styles.buttonPrimary}`} type="submit" disabled={apiKeySaving}><Check size={15} />{apiKeySaving ? '保存中…' : '保存配置'}</button><button className={styles.button} type="button" onClick={generateNewApiKey} disabled={apiKeySaving}><KeyRound size={15} />生成新密钥</button></div>
              </form>
              <div className={styles.integrationNote}><strong>sub2api 配置</strong><div><span>Base URL</span><code>{apiEndpoint}</code></div><div><span>API Key</span><code>{status?.apiKeyMasked || '使用上方密钥'}</code></div><div><span>推荐模型</span><code>{DEFAULT_OPENAI_MODEL}</code></div><div><span>模型列表</span><code>GET /v1/models</code></div></div>
            </div>
          </section>
        </div>
      </>
    );
  }

  function renderCaptcha() {
    const status = captchaStatus;
    const yesDiagnostics = status?.providers?.yescaptcha;
    const twoDiagnostics = status?.providers?.['2captcha'];
    const apiStateLabel = (state?: string) => state === 'reachable'
      ? '可连接'
      : state === 'unreachable'
        ? '不可连接'
        : '未检测';
    const providerLabel =
      status?.provider === 'yescaptcha'
        ? 'YesCaptcha'
        : status?.provider === '2captcha'
          ? '2Captcha'
          : '未配置';
    const failureLabel = (code?: string | null) => {
      if (!code) return '';
      if (code === 'provider_timeout') return '解题超时';
      if (code === 'provider_transport_error') return '服务商网络失败';
      if (code === 'ERROR_CAPTCHA_UNSOLVABLE') return '验证码不可解';
      if (code === 'ERROR_TASK_TIMEOUT') return '服务商任务超时';
      if (code === 'ERROR_NO_SLOT_AVAILABLE') return '暂无解题资源';
      return code;
    };
    const recentFailures = [
      yesDiagnostics?.solve?.lastCode
        ? `YesCaptcha：${failureLabel(yesDiagnostics.solve.lastCode)}`
        : '',
      twoDiagnostics?.solve?.lastCode
        ? `2Captcha：${failureLabel(twoDiagnostics.solve.lastCode)}`
        : '',
    ].filter(Boolean).join('；');
    return (
      <>
        {renderPageHeader(
          '验证码配置',
          '配置 YesCaptcha 和 2Captcha，保存后立即生效，无需重启容器。',
          <><button className={styles.button} type="button" onClick={probeCaptchaProviders} disabled={captchaProbeLoading}><ShieldCheck size={14} />{captchaProbeLoading ? '检测中…' : '检测 API 连通'}</button><button className={styles.button} type="button" onClick={refreshCaptchaStatus} disabled={captchaLoading}><RefreshCw size={14} className={captchaLoading ? styles.spin : undefined} />{captchaLoading ? '刷新中…' : '刷新状态'}</button></>,
        )}
        <div className={styles.settingsLayout}>
          <aside className={styles.settingsSummary}>
            <div className={styles.settingsSummaryIcon}><ShieldCheck size={19} /></div>
            <h2>验证服务状态</h2>
            <p>系统会按策略自动选择可用的打码服务。</p>
            <div className={styles.settingsStatusList}>
              <div className={styles.settingsStatusRow}><span>当前提供商</span><strong className={providerLabel === '未配置' ? styles.textWarning : styles.textSuccess}>{providerLabel}</strong></div>
              <div className={styles.settingsStatusRow}><span>API 传输</span><strong>{status?.network?.apiTransportMode === 'proxy' ? '独立代理' : '直连'}</strong></div>
              <div className={styles.settingsStatusRow}><span>远程 Worker</span><strong>{status?.network?.workerMode === 'external_proxy' ? '外部代理' : 'Proxyless'}</strong></div>
              <div className={styles.settingsStatusRow}><span>CAPTCHA 并发</span><strong>{status?.coordinator ? `${status.coordinator.active}/${status.coordinator.limit}` : '--'}</strong></div>
              <div className={styles.settingsStatusRow}><span>YesCaptcha API</span><strong>{apiStateLabel(yesDiagnostics?.api?.state)}</strong></div>
              <div className={styles.settingsStatusRow}><span>Yes Token / Suno 接受</span><strong>{yesDiagnostics ? `${yesDiagnostics.solve?.tokensReturned || 0}/${yesDiagnostics.suno?.accepted || 0}` : '--'}</strong></div>
              <div className={styles.settingsStatusRow}><span>2Captcha API</span><strong>{apiStateLabel(twoDiagnostics?.api?.state)}</strong></div>
              <div className={styles.settingsStatusRow}><span>2C Token / Suno 接受</span><strong>{twoDiagnostics ? `${twoDiagnostics.solve?.tokensReturned || 0}/${twoDiagnostics.suno?.accepted || 0}` : '--'}</strong></div>
              <div className={styles.settingsStatusRow}><span>超时 / 平均耗时</span><strong>{`${(yesDiagnostics?.solve?.timeouts || 0) + (twoDiagnostics?.solve?.timeouts || 0)} / ${Math.round(((yesDiagnostics?.solve?.averageDurationMs || 0) + (twoDiagnostics?.solve?.averageDurationMs || 0)) / ((yesDiagnostics?.solve?.averageDurationMs ? 1 : 0) + (twoDiagnostics?.solve?.averageDurationMs ? 1 : 0) || 1))}ms`}</strong></div>
              <div className={styles.settingsStatusRow}><span>最近解题失败</span><strong>{recentFailures || '无'}</strong></div>
              <div className={styles.settingsStatusRow}><span>熔断状态</span><strong>{yesDiagnostics?.circuit?.state === 'open' || twoDiagnostics?.circuit?.state === 'open' ? '已熔断' : '正常'}</strong></div>
              <div className={styles.settingsStatusRow}><span>YesCaptcha Key</span><strong>{status?.yescaptchaKeyMasked || '未配置'}</strong></div>
              <div className={styles.settingsStatusRow}><span>2Captcha Key</span><strong>{status?.twocaptchaKeyMasked || '未配置'}</strong></div>
            </div>
            <p className={styles.settingsHint}>建议同时配置两个提供商，并保留自动策略作为故障切换。</p>
          </aside>
          <section className={`${styles.panel} ${styles.settingsMain}`}>
            <div className={styles.panelHeader}><div><h2 className={styles.panelTitle}>服务参数</h2><p className={styles.panelDescription}>密钥留空表示保留当前值，输入 CLEAR 可清空。</p></div></div>
            <div className={styles.panelBody}>
              <form className={styles.settingsForm} onSubmit={saveCaptchaSettings}>
                <div className={styles.formGridTwo}><label className={styles.field}><span className={styles.fieldLabel}>提供商策略</span><select className={styles.select} value={captchaForm.provider} onChange={(e) => setCaptchaForm((prev) => ({ ...prev, provider: e.target.value as any }))}><option value="auto">自动（主服务失败后切换备用）</option><option value="yescaptcha">优先 YesCaptcha</option><option value="2captcha">优先 2Captcha</option></select></label><label className={styles.field}><span className={styles.fieldLabel}>打码模式</span><select className={styles.select} value={captchaForm.captchaMode} onChange={(e) => setCaptchaForm((prev) => ({ ...prev, captchaMode: e.target.value as any }))}><option value="auto">动态挑战 Token</option><option value="token">仅动态 Token API</option><option value="click">旧点选设置（按动态 Token 执行）</option></select></label></div>
                <label className={`${styles.field} ${styles.fieldFull}`}><span className={styles.fieldLabel}>YesCaptcha API 地址</span><input className={styles.input} value={captchaForm.yescaptchaBaseUrl} onChange={(e) => setCaptchaForm((prev) => ({ ...prev, yescaptchaBaseUrl: e.target.value }))} placeholder="https://api.yescaptcha.com" /></label>
                <label className={`${styles.field} ${styles.fieldFull}`}><span className={styles.fieldLabel}>YesCaptcha Key</span><div className={styles.passwordField}><input className={styles.input} type={captchaForm.showYesKey ? 'text' : 'password'} value={captchaForm.yescaptchaKey} onChange={(e) => setCaptchaForm((prev) => ({ ...prev, yescaptchaKey: e.target.value }))} placeholder={status?.yescaptchaKeyMasked ? `当前 ${status.yescaptchaKeyMasked}` : '粘贴 YesCaptcha ClientKey'} autoComplete="off" /><button className={styles.iconButton} type="button" onClick={() => setCaptchaForm((prev) => ({ ...prev, showYesKey: !prev.showYesKey }))} aria-label={captchaForm.showYesKey ? '隐藏 YesCaptcha Key' : '显示 YesCaptcha Key'}>{captchaForm.showYesKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
                <label className={`${styles.field} ${styles.fieldFull}`}><span className={styles.fieldLabel}>2Captcha Key</span><div className={styles.passwordField}><input className={styles.input} type={captchaForm.showTwoKey ? 'text' : 'password'} value={captchaForm.twocaptchaKey} onChange={(e) => setCaptchaForm((prev) => ({ ...prev, twocaptchaKey: e.target.value }))} placeholder={status?.twocaptchaKeyMasked ? `当前 ${status.twocaptchaKeyMasked}` : '粘贴 2Captcha API Key'} autoComplete="off" /><button className={styles.iconButton} type="button" onClick={() => setCaptchaForm((prev) => ({ ...prev, showTwoKey: !prev.showTwoKey }))} aria-label={captchaForm.showTwoKey ? '隐藏 2Captcha Key' : '显示 2Captcha Key'}>{captchaForm.showTwoKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
                <div className={styles.buttonRow}><button className={`${styles.button} ${styles.buttonPrimary}`} type="submit" disabled={captchaSaving}><ShieldCheck size={15} />{captchaSaving ? '保存中…' : '保存配置'}</button><button className={styles.button} type="button" disabled={captchaSaving} onClick={() => setCaptchaForm((prev) => ({ ...prev, provider: '2captcha' }))}>切换为 2Captcha</button></div>
              </form>
              {status?.yescaptchaError && <div className={`${styles.notice} ${styles.noticeError}`}><X size={16} />{status.yescaptchaError}</div>}
              <div className={styles.helpBox}><div className={styles.helpTitle}>运行说明</div><div className={styles.helpText}>配置写入服务器 `data/captcha-settings.json`，保存后运行时立即生效。更新时间：{status?.updatedAt ? formatDate(status.updatedAt) : '尚未通过面板保存'}。</div></div>
            </div>
          </section>
        </div>
      </>
    );
  }

  return (
    <AdminShell
      activeView={activeView}
      sidebarOpen={sidebarOpen}
      onSidebarOpenChange={setSidebarOpen}
      onViewChange={switchView}
      onRefresh={loadDashboard}
      refreshing={refreshing}
      onLogout={logout}
      apiEndpoint={apiEndpoint}
      lastUpdated={lastUpdated ? formatDate(lastUpdated) : null}
      activeAccounts={activeAccounts}
      totalAccounts={accounts.length}
      copiedEndpoint={copiedCommand === 'api-base'}
      onCopyEndpoint={() => copyText(apiEndpoint, 'api-base')}
    >
      <div className={styles.contentInner}>
        {error && <div className={`${styles.notice} ${styles.noticeError}`}><X size={16} />{error}</div>}
        {message && <div className={`${styles.notice} ${styles.noticeInfo}`}><Check size={16} />{message}</div>}
        {activeView === 'overview' && renderOverview()}
        {activeView === 'accounts' && renderAccounts()}
        {activeView === 'concurrency' && renderConcurrency()}
        {activeView === 'generate' && renderGenerate()}
        {activeView === 'tasks' && renderTasks()}
        {activeView === 'apikey' && renderApiKey()}
        {activeView === 'captcha' && renderCaptcha()}
        {activeView === 'billing' && renderBilling()}
        {activeView === 'models' && renderModels()}
      </div>
      {renderAuthWizard()}
    </AdminShell>
  );
}
