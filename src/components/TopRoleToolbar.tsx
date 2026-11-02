import React from 'react';
import {CheckCircle2, LogOut, Signal, WifiOff} from 'lucide-react';
import {NetworkState} from '../types/triage';
import {PWAInstallButton} from './PWAInstallButton';

export type UserRole = 'ASHA' | 'DMO' | null;
export type CurrentView = 'LOGIN' | 'ASHA_MOBILE' | 'DMO_DASHBOARD';
export type AshaNavTab = 'checkup' | 'records' | 'assistant' | 'activity';
export type DmoNavTab = 'overview' | 'urgent' | 'records' | 'workers' | 'sms';

interface TopRoleToolbarProps {
  isAuthenticated: boolean;
  userRole: UserRole;
  userIdentifier: string;
  userDisplayName?: string;
  isLocalSession?: boolean;
  networkState: NetworkState;
  browserOnline: boolean;
  pendingOfflineCount?: number;
  ashaTab?: AshaNavTab;
  onSelectAshaTab?: (tab: AshaNavTab) => void;
  dmoTab?: DmoNavTab;
  onSelectDmoTab?: (tab: DmoNavTab) => void;
  onSelectNetwork: (mode: NetworkState) => void;
  onLogout: () => void;
  onLogoutAllDevices?: () => void;
}

export const TopRoleToolbar: React.FC<TopRoleToolbarProps> = ({
  isAuthenticated,
  userRole,
  userIdentifier,
  userDisplayName,
  isLocalSession = false,
  networkState,
  browserOnline,
  pendingOfflineCount = 0,
  ashaTab = 'checkup',
  onSelectAshaTab,
  dmoTab = 'overview',
  onSelectDmoTab,
  onSelectNetwork,
  onLogout,
  onLogoutAllDevices,
}) => {
  return (
    <div className="w-full shrink-0">
      {/* Strict 3-Zone Top Bar Contract (compact h-14 sticky header) */}
      <header className="sticky top-0 z-30 h-14 w-full border-b border-slate-200 bg-white/95 backdrop-blur-md">
        <div className="mx-auto flex h-full max-w-7xl items-center justify-between gap-6 px-4 sm:px-6">
          {/* Zone 1: Single-line Brand Wordmark */}
          <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            SwasthyaSetu
          </span>

          {/* Zone 2: Clean Single-Line Text Navigation Links */}
          <nav
            aria-label="Primary Navigation"
            className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600"
          >
            {isAuthenticated && userRole === 'ASHA' && onSelectAshaTab ? (
              <>
                <button
                  type="button"
                  onClick={() => onSelectAshaTab('checkup')}
                  className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    ashaTab === 'checkup'
                      ? 'text-teal-700 font-semibold underline underline-offset-8 decoration-2'
                      : 'hover:text-slate-900'
                  }`}
                >
                  New Checkup
                </button>
                <button
                  type="button"
                  onClick={() => onSelectAshaTab('records')}
                  className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    ashaTab === 'records'
                      ? 'text-teal-700 font-semibold underline underline-offset-8 decoration-2'
                      : 'hover:text-slate-900'
                  }`}
                >
                  Saved Records
                </button>
                <button
                  type="button"
                  onClick={() => onSelectAshaTab('assistant')}
                  className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    ashaTab === 'assistant'
                      ? 'text-teal-700 font-semibold underline underline-offset-8 decoration-2'
                      : 'hover:text-slate-900'
                  }`}
                >
                  Voice Helper
                </button>
                <button
                  type="button"
                  onClick={() => onSelectAshaTab('activity')}
                  className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    ashaTab === 'activity'
                      ? 'text-teal-700 font-semibold underline underline-offset-8 decoration-2'
                      : 'hover:text-slate-900'
                  }`}
                >
                  Activity Log
                </button>
              </>
            ) : isAuthenticated && userRole === 'DMO' && onSelectDmoTab ? (
              <>
                <button
                  type="button"
                  onClick={() => onSelectDmoTab('overview')}
                  className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    dmoTab === 'overview'
                      ? 'text-teal-700 font-semibold underline underline-offset-8 decoration-2'
                      : 'hover:text-slate-900'
                  }`}
                >
                  Overview
                </button>
                <button
                  type="button"
                  onClick={() => onSelectDmoTab('urgent')}
                  className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    dmoTab === 'urgent'
                      ? 'text-teal-700 font-semibold underline underline-offset-8 decoration-2'
                      : 'hover:text-slate-900'
                  }`}
                >
                  Urgent Referrals
                </button>
                <button
                  type="button"
                  onClick={() => onSelectDmoTab('records')}
                  className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    dmoTab === 'records'
                      ? 'text-teal-700 font-semibold underline underline-offset-8 decoration-2'
                      : 'hover:text-slate-900'
                  }`}
                >
                  Patient Records
                </button>
                <button
                  type="button"
                  onClick={() => onSelectDmoTab('workers')}
                  className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    dmoTab === 'workers'
                      ? 'text-teal-700 font-semibold underline underline-offset-8 decoration-2'
                      : 'hover:text-slate-900'
                  }`}
                >
                  Health Workers
                </button>
                <button
                  type="button"
                  onClick={() => onSelectDmoTab('sms')}
                  className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    dmoTab === 'sms'
                      ? 'text-teal-700 font-semibold underline underline-offset-8 decoration-2'
                      : 'hover:text-slate-900'
                  }`}
                >
                  SMS Tools
                </button>
              </>
            ) : (
              <>
                <a
                  href="#sign-in-card"
                  className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
                >
                  Sign In
                </a>
                <a
                  href="#care-features"
                  className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
                >
                  How It Works
                </a>
                <a
                  href="#privacy-notice"
                  className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
                >
                  Patient Privacy
                </a>
              </>
            )}
          </nav>

          {/* Zone 3: Single Primary Contextual Action */}
          <div className="flex items-center shrink-0">
            {isAuthenticated && userRole ? (
              <button
                type="button"
                onClick={onLogout}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <LogOut className="h-3.5 w-3.5 text-slate-500" />
                <span>Sign Out</span>
              </button>
            ) : (
              <PWAInstallButton compact />
            )}
          </div>
        </div>
      </header>

      {/* Non-sticky Workspace Connection & Sync Toolbar (below header) */}
      <div className="w-full border-b border-slate-200 bg-slate-100/70">
        <div className="mx-auto flex max-w-7xl flex-col gap-2.5 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          {/* Plain-Language Connection & Sync Status */}
          <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
            {networkState === 'offline' ? (
              <>
                <WifiOff className="h-4 w-4 shrink-0 text-amber-700" />
                <span>
                  <strong className="font-semibold text-slate-900">Working Offline:</strong> Records
                  are encrypted on this device and sync automatically when internet returns
                  {pendingOfflineCount > 0 ? ` (${pendingOfflineCount} waiting to sync)` : ''}.
                  {!browserOnline ? ' Device is currently offline.' : ''}
                </span>
              </>
            ) : networkState === '2g' ? (
              <>
                <Signal className="h-4 w-4 shrink-0 text-amber-700" />
                <span>
                  <strong className="font-semibold text-slate-900">Low Signal Mode:</strong>{' '}
                  Lightweight data sync is active for weak rural mobile networks.
                </span>
              </>
            ) : isLocalSession ? (
              <>
                <Signal className="h-4 w-4 shrink-0 text-teal-700" />
                <span>
                  <strong className="font-semibold text-slate-900">Saved on Device:</strong>{' '}
                  Checkups are encrypted locally
                  {pendingOfflineCount > 0 ? ` (${pendingOfflineCount} waiting to sync)` : ''} —
                  sign in again when online to sync with the hospital.
                </span>
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" />
                <span>
                  <strong className="font-semibold text-slate-900">Connected:</strong> Checkups are
                  encrypted and synced securely with the hospital
                  {pendingOfflineCount > 0 ? ` (${pendingOfflineCount} syncing...)` : '.'}
                </span>
              </>
            )}

            {isAuthenticated && userIdentifier && (
              <span className="hidden lg:inline text-slate-500">
                · Signed in as {userDisplayName || userIdentifier}
              </span>
            )}
          </div>

          {/* Interactive Connection Mode Selector + Install App when signed in */}
          <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
            <div
              role="group"
              aria-label="Connection Mode"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-200/70 p-0.5"
            >
              <button
                type="button"
                onClick={() => onSelectNetwork('4g')}
                className={`min-h-[34px] rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  networkState === '4g'
                    ? 'bg-white text-slate-900 font-semibold shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Online
              </button>
              <button
                type="button"
                onClick={() => onSelectNetwork('2g')}
                className={`min-h-[34px] rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  networkState === '2g'
                    ? 'bg-white text-slate-900 font-semibold shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Low Signal
              </button>
              <button
                type="button"
                onClick={() => onSelectNetwork('offline')}
                className={`min-h-[34px] rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  networkState === 'offline'
                    ? 'bg-white text-amber-900 font-semibold shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Offline
              </button>
            </div>

            {isAuthenticated && !isLocalSession && onLogoutAllDevices && (
              <button
                type="button"
                onClick={onLogoutAllDevices}
                className="min-h-[34px] rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Sign Out All Devices
              </button>
            )}

            {isAuthenticated && <PWAInstallButton compact />}
          </div>
        </div>
      </div>
    </div>
  );
};
