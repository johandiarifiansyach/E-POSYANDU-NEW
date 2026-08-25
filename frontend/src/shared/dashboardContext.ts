// @ts-nocheck
import Native, { useState, useEffect, useLayoutEffect, useMemo, useRef } from '../runtime/dom';
import { initializeApp, reportAccountPresence } from '../api/authApi';
import { getCachedChildrenPage, getChildDetail, getChildrenPage } from '../api/childrenApi';
import { getChangeHistory, getDashboardStats, getMonitoringStatus } from '../api/dashboardApi';
import { getDocsForExport } from '../api/exportApi';
import { getSigiziMeasurementExport } from '../api/measurementApi';
import { addDoc, collection, deleteDoc, doc, getDocs, getFirestore, onSnapshot, orderBy, query, resolveSyncConflict, serverTimestamp, subscribeToSyncConflicts, subscribeToSyncedMutations, syncActiveViewFromServer, syncPendingMutations, updateDoc, where, listSyncConflicts } from '../api/syncApi';
import { DATA_WILAYAH, ROLES, isFullAccessRole, DASHBOARD_TABS, COMPACT_SIDEBAR_MEDIA_QUERY, MONTHS, YEARS } from '../config/dashboard';
import { formatChildName, getKBM, formatDate, formatIndoDate, formatIndoDateTime, getAgeInMonths, calculateZScore, calculateGiziStatus, generateRandomDigits, normalizeDecimalInput, parseLocaleNumber, parseLocaleNumberForRange } from './dashboardUtils';
import { ensureXlsx } from '../services/xlsx';
import { Card, InputGroup, LocationFilterPanel } from '../ui/dashboardPrimitives';
import { Button, Select, Badge, KenaikanBadge, StatusBadge } from '../components';
import { getPreferredColorScheme, saveColorScheme, subscribeColorScheme } from '../theme/colorScheme';
import { Activity, Ruler, LogOut, Plus, MapPin, Clock, Baby, XCircle, ChevronDown, ChevronLeft, ChevronRight, Loader2, LayoutDashboard, Users, Trash2, Menu, AlertTriangle, TrendingDown, AlertCircle, Minus, Utensils, Gift, ClipboardCheck, CheckSquare, History, Filter, RotateCcw, UserRound, X, Moon, Sun } from '../ui/icons';
import { showError, showSuccess } from '../ui/notifications';
import { openReleaseNotes } from '../ui/releaseNotes';
import { DashboardPageSkeleton } from '../ui/skeleton';
import { db, appId } from '../app/session';

export {
    Native, useState, useEffect, useLayoutEffect, useMemo, useRef,
    getFirestore, collection, addDoc, query, where, onSnapshot, serverTimestamp,
    updateDoc, doc, deleteDoc, getDocs, getDocsForExport, getCachedChildrenPage,
    getChangeHistory, getChildDetail, getChildrenPage, getDashboardStats,
    getMonitoringStatus, getSigiziMeasurementExport, initializeApp, reportAccountPresence,
    listSyncConflicts, resolveSyncConflict, subscribeToSyncConflicts,
    subscribeToSyncedMutations, syncActiveViewFromServer, syncPendingMutations,
    orderBy, DATA_WILAYAH, ROLES, isFullAccessRole, DASHBOARD_TABS, COMPACT_SIDEBAR_MEDIA_QUERY,
    MONTHS, YEARS, formatChildName, getKBM, formatDate, formatIndoDate,
    formatIndoDateTime, getAgeInMonths, calculateZScore, calculateGiziStatus,
    generateRandomDigits, normalizeDecimalInput, parseLocaleNumber,
    parseLocaleNumberForRange, ensureXlsx, Card, Button, InputGroup, Select,
    LocationFilterPanel, Badge, KenaikanBadge, StatusBadge,
    getPreferredColorScheme, saveColorScheme, subscribeColorScheme,
    Activity, Ruler, LogOut, Plus, MapPin, Clock, Baby, XCircle, ChevronDown,
    ChevronLeft, ChevronRight, Loader2, LayoutDashboard, Users, Trash2, Menu,
    AlertTriangle, TrendingDown, AlertCircle, Minus, Utensils, Gift,
    ClipboardCheck, CheckSquare, History, Filter, RotateCcw, UserRound, X,
    Moon, Sun, showError, showSuccess, openReleaseNotes, DashboardPageSkeleton, db, appId
};
