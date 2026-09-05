'use client';

import { useEffect, type ReactNode } from 'react';
import {
  Activity,
  BookOpen,
  Boxes,
  Calculator,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Gauge,
  KeyRound,
  LayoutDashboard,
  ListMusic,
  LogOut,
  Menu,
  Music2,
  RefreshCw,
  ShieldCheck,
  UsersRound,
  WandSparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import styles from './AdminShell.module.css';

export type AdminView = 'overview' | 'generate' | 'tasks' | 'accounts' | 'concurrency' | 'captcha' | 'apikey' | 'billing' | 'models';

export interface AdminShellProps {
  activeView: AdminView;
  sidebarOpen: boolean;
  onSidebarOpenChange: (open: boolean) => void;
  onViewChange: (view: AdminView) => void;
  onRefresh: () => void;
  refreshing: boolean;
  onLogout: () => void;
  apiEndpoint: string;
  lastUpdated: string | null;
  activeAccounts: number;
  totalAccounts: number;
  copiedEndpoint: boolean;
  onCopyEndpoint: () => void;
  children: ReactNode;
}

type NavItem = {
  view: AdminView;
  label: string;
  icon: LucideIcon;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const navGroups: NavGroup[] = [
  {
    label: '工作台',
    items: [{ view: 'overview', label: '运行概览', icon: LayoutDashboard }],
  },
  {
    label: '生产运营',
    items: [
      { view: 'generate', label: '音乐生成', icon: WandSparkles },
      { view: 'tasks', label: '任务记录', icon: ListMusic },
    ],
  },
  {
    label: '账号资源',
    items: [
      { view: 'accounts', label: '账号池', icon: UsersRound },
      { view: 'concurrency', label: '并发控制', icon: Gauge },
    ],
  },
  {
    label: '安全与接入',
    items: [
      { view: 'captcha', label: '验证码配置', icon: ShieldCheck },
      { view: 'apikey', label: '接口密钥', icon: KeyRound },
    ],
  },
  {
    label: '计费管理',
    items: [{ view: 'billing', label: '积分与倍率', icon: Calculator }],
  },
];

const viewMeta: Record<AdminView, { section: string; title: string; description: string }> = {
  overview: { section: '工作台', title: '运行概览', description: '账号、额度与任务运行状态' },
  generate: { section: '生产运营', title: '音乐生成', description: '创建并提交新的音乐任务' },
  tasks: { section: '生产运营', title: '任务记录', description: '查看生成进度与历史结果' },
  accounts: { section: '账号资源', title: '账号池', description: '维护分级账号、并发与配额' },
  concurrency: { section: '账号资源', title: '并发控制', description: '管理请求容量与实时占用' },
  captcha: { section: '安全与接入', title: '验证码配置', description: '管理验证服务与故障切换' },
  apikey: { section: '安全与接入', title: '接口密钥', description: '管理 OpenAI 兼容接口访问' },
  billing: { section: '计费管理', title: '积分与倍率', description: '计算固定请求价与积分扣除' },
  models: { section: '开发者', title: '模型目录', description: '查看可发现的模型与上游映射' },
};

export default function AdminShell({
  activeView,
  sidebarOpen,
  onSidebarOpenChange,
  onViewChange,
  onRefresh,
  refreshing,
  onLogout,
  apiEndpoint,
  lastUpdated,
  activeAccounts,
  totalAccounts,
  copiedEndpoint,
  onCopyEndpoint,
  children,
}: AdminShellProps) {
  const currentView = viewMeta[activeView];
  const safeActiveAccounts = Math.max(0, activeAccounts);
  const safeTotalAccounts = Math.max(0, totalAccounts);
  const accountTone =
    safeTotalAccounts === 0 || safeActiveAccounts === 0
      ? styles.accountStatusDanger
      : safeActiveAccounts < safeTotalAccounts
        ? styles.accountStatusWarning
        : styles.accountStatusHealthy;

  useEffect(() => {
    if (!sidebarOpen) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onSidebarOpenChange(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSidebarOpenChange, sidebarOpen]);

  const selectView = (view: AdminView) => {
    onViewChange(view);
    onSidebarOpenChange(false);
  };

  return (
    <div className={styles.adminShell}>
      <a className={styles.skipLink} href="#admin-content">
        跳到主要内容
      </a>

      {sidebarOpen && (
        <button
          className={styles.backdrop}
          type="button"
          aria-label="关闭导航"
          onClick={() => onSidebarOpenChange(false)}
        />
      )}

      <aside
        id="admin-sidebar"
        className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ''}`}
        aria-label="管理后台导航"
      >
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            <Music2 size={18} strokeWidth={2.2} />
          </span>
          <span className={styles.brandText}>
            <strong>SUNO API</strong>
            <small>运营控制台</small>
          </span>
          <button
            className={`${styles.iconButton} ${styles.sidebarClose}`}
            type="button"
            title="关闭导航"
            aria-label="关闭导航"
            onClick={() => onSidebarOpenChange(false)}
          >
            <X size={18} />
          </button>
        </div>

        <nav className={styles.nav} aria-label="功能模块">
          {navGroups.map((group) => (
            <section className={styles.navGroup} key={group.label} aria-labelledby={`nav-${group.label}`}>
              <h2 className={styles.navGroupLabel} id={`nav-${group.label}`}>
                {group.label}
              </h2>
              <div className={styles.navItems}>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeView === item.view;

                  return (
                    <button
                      className={`${styles.navItem} ${isActive ? styles.navItemActive : ''}`}
                      type="button"
                      key={item.view}
                      aria-current={isActive ? 'page' : undefined}
                      onClick={() => selectView(item.view)}
                    >
                      <Icon size={17} strokeWidth={1.9} aria-hidden="true" />
                      <span>{item.label}</span>
                      {isActive && <ChevronRight className={styles.navChevron} size={14} aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}

          <section className={styles.navGroup} aria-labelledby="nav-developer">
            <h2 className={styles.navGroupLabel} id="nav-developer">
              开发者
            </h2>
            <div className={styles.navItems}>
              <button
                className={`${styles.navItem} ${activeView === 'models' ? styles.navItemActive : ''}`}
                type="button"
                aria-current={activeView === 'models' ? 'page' : undefined}
                onClick={() => selectView('models')}
              >
                <Boxes size={17} strokeWidth={1.9} aria-hidden="true" />
                <span>模型目录</span>
                {activeView === 'models' && <ChevronRight className={styles.navChevron} size={14} aria-hidden="true" />}
              </button>
              <a className={styles.navItem} href="/docs" target="_blank" rel="noreferrer">
                <BookOpen size={17} strokeWidth={1.9} aria-hidden="true" />
                <span>接口文档</span>
                <ExternalLink className={styles.navExternal} size={14} aria-hidden="true" />
              </a>
            </div>
          </section>
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.serviceStatus} role="status">
            <span className={styles.serviceDot} aria-hidden="true" />
            <span>API 服务运行中</span>
            <span className={styles.serviceTag}>ONLINE</span>
          </div>
          <span className={styles.endpointLabel}>OpenAI 兼容地址</span>
          <button
            className={styles.endpointButton}
            type="button"
            title="复制接口地址"
            aria-label={`复制接口地址 ${apiEndpoint}`}
            onClick={onCopyEndpoint}
          >
            <code>{apiEndpoint || '尚未配置'}</code>
            {copiedEndpoint ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
          </button>
          <span className={styles.copyStatus} aria-live="polite">
            {copiedEndpoint ? '接口地址已复制' : '点击地址可复制'}
          </span>
        </div>
      </aside>

      <header className={styles.topbar}>
        <div className={styles.topbarLeft}>
          <button
            className={`${styles.iconButton} ${styles.menuButton}`}
            type="button"
            title={sidebarOpen ? '关闭导航' : '打开导航'}
            aria-label={sidebarOpen ? '关闭导航' : '打开导航'}
            aria-controls="admin-sidebar"
            aria-expanded={sidebarOpen}
            onClick={() => onSidebarOpenChange(!sidebarOpen)}
          >
            {sidebarOpen ? <X size={19} /> : <Menu size={19} />}
          </button>

          <div className={styles.pageIdentity}>
            <div className={styles.breadcrumb} aria-label="当前位置">
              <span>{currentView.section}</span>
              <ChevronRight size={13} aria-hidden="true" />
              <strong>{currentView.title}</strong>
            </div>
            <span className={styles.pageDescription}>{currentView.description}</span>
          </div>
        </div>

        <div className={styles.topbarActions}>
          <div className={`${styles.accountStatus} ${accountTone}`} title="可用账号 / 账号总数">
            <Activity size={15} aria-hidden="true" />
            <span>
              <strong>{safeActiveAccounts}</strong> / {safeTotalAccounts} 个账号可用
            </span>
          </div>
          <span className={styles.lastUpdated} title={lastUpdated ? `最后更新：${lastUpdated}` : '尚未同步数据'}>
            {lastUpdated ? `更新于 ${lastUpdated}` : '尚未同步'}
          </span>
          <span className={styles.actionDivider} aria-hidden="true" />
          <button
            className={styles.iconButton}
            type="button"
            title="刷新全部数据"
            aria-label={refreshing ? '正在刷新全部数据' : '刷新全部数据'}
            aria-busy={refreshing}
            disabled={refreshing}
            onClick={onRefresh}
          >
            <RefreshCw className={refreshing ? styles.spin : undefined} size={17} />
          </button>
          <button
            className={`${styles.iconButton} ${styles.logoutButton}`}
            type="button"
            title="退出管理后台"
            aria-label="退出管理后台"
            onClick={onLogout}
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>

      <main className={styles.main} id="admin-content" tabIndex={-1}>
        <div className={styles.content}>{children}</div>
      </main>
    </div>
  );
}
