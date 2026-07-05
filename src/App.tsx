import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { 
  auth,
  onAuthStateChanged,
  signInWithGoogle,
  signOutUser
} from './lib/auth';
import { 
  db, 
  collection, 
  doc, 
  setDoc, 
  addDoc, 
  query, 
  where, 
  orderBy, 
  onSnapshot, 
  updateDoc, 
  deleteDoc 
} from './firebase';
import { GoogleGenAI, Type } from "@google/genai";
import { 
  Brain, 
  Zap, 
  CheckCircle2, 
  Plus, 
  LogOut, 
  LogIn, 
  Trash2, 
  ChevronRight, 
  Clock, 
  Lightbulb, 
  Filter,
  Loader2,
  Edit3,
  Layout,
  Folder,
  Target,
  Layers,
  Eye,
  StickyNote,
  Moon,
  Sun,
  GripVertical,
  Calendar,
  Archive,
  Repeat,
  Activity,
  BarChart3,
  Hourglass,
  AlertCircle,
  RotateCcw
} from 'lucide-react';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import { cn } from './lib/utils';

// --- Constants ---
// --- Helpers ---
const calculateDeadlineProgress = (createdAt: string, deadline: string) => {
  const start = new Date(createdAt).getTime();
  const end = new Date(deadline).getTime();
  const now = new Date().getTime();

  if (isNaN(start) || isNaN(end)) return null;

  const total = end - start;
  const elapsed = now - start;
  
  if (now > end) {
    return {
      percentage: 100,
      remainingText: "Overdue",
      status: 'critical' as const
    };
  }

  const percentage = Math.min(Math.max((elapsed / total) * 100, 0), 100);
  
  const diffMs = end - now;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  
  let remainingText = "";
  if (diffDays > 0) {
    remainingText = `${diffDays}d left`;
  } else if (diffHours > 0) {
    remainingText = `${diffHours}h left`;
  } else {
    remainingText = "Due soon";
  }

  let status: 'normal' | 'warning' | 'critical' = 'normal';
  if (percentage > 85 || diffMs < (1000 * 60 * 60 * 24)) {
    status = 'critical';
  } else if (percentage > 60) {
    status = 'warning';
  }

  return { percentage, remainingText, status };
};

const getPriorityClasses = (priority?: Priority) => {
  if (!priority) return "";
  switch (priority) {
    case 'high': return "bg-red-100/60 dark:bg-red-900/20 border-red-200 dark:border-red-900/50 shadow-red-100/50 dark:shadow-none";
    case 'moderate': return "bg-blue-100/60 dark:bg-blue-900/20 border-blue-200 dark:border-blue-900/50 shadow-blue-100/50 dark:shadow-none";
    case 'low': return "bg-green-100/60 dark:bg-green-900/20 border-green-200 dark:border-green-900/50 shadow-green-100/50 dark:shadow-none";
    default: return "";
  }
};

const getHabitWeekRange = (date: Date) => {
  const d = new Date(date);
  const day = d.getDay(); 
  const diffToFri = (day + 2) % 7;
  const start = new Date(d);
  start.setDate(d.getDate() - diffToFri);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

const getLocalDateString = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const EF_BEST_PRACTICES = [
  {
    title: "Break it Down",
    description: "If a task feels overwhelming, break it into 3 tiny subtasks. Small wins build momentum."
  },
  {
    title: "Time Boxing",
    description: "Give a task a 'budget' (e.g., 15 mins). It stops perfectionism from wasting your time."
  },
  {
    title: "The 2-Minute Rule",
    description: "If it takes less than 2 minutes, do it now. Don't add it to your list."
  },
  {
    title: "External Memory",
    description: "Your brain is for having ideas, not holding them. Write everything down immediately."
  },
  {
    title: "Context Switching",
    description: "Group similar tasks together. Switching between different types of work drains your energy."
  }
];

// --- Types ---
type Priority = 'low' | 'moderate' | 'high';
type ItemType = 'task' | 'project' | 'note' | 'life_area' | 'habit';

interface Subtask {
  id: string;
  title: string;
  completed: boolean;
}

interface HabitLog {
  date: string;
  value: number | boolean;
  timestamp?: string;
}

interface HabitConfig {
  type: 'boolean' | 'numeric';
  goal?: number;
  unit?: string;
}

interface BrainDumpItem {
  id: string;
  userId: string;
  parentId?: string;
  type: ItemType;
  title: string;
  life_area: string;
  original_intent: string;
  subtasks: Subtask[];
  createdAt: string;
  completed: boolean;
  completedAt?: string;
  deadline?: string;
  scope?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  recurrence?: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'none';
  position?: number;
  habit_config?: HabitConfig;
  habit_logs?: HabitLog[];
  time_budget?: number;
  priority?: Priority;
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

// --- Error Handling ---
function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  // Removed throw to prevent app from crashing and triggering automatic reloads
}

// --- Gemini Service ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

const processBrainDump = async (text: string): Promise<Partial<BrainDumpItem>> => {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Analyze this brain dump for an ADHD brain: "${text}"`,
    config: {
      systemInstruction: `You are the "Executive Function Engine," a specialized AI backend for a Second Brain tool designed specifically for ADHD brains. Your goal is to eliminate "decisional paralysis" and "organizational overwhelm" by transforming messy, unstructured brain dumps into highly organized, actionable data.
      NEVER be judgmental.
      ROUTE everything into one of five categories: [Task, Project, Life Area, Note, Habit].
      Habits: If it's a recurring action, categorize as 'habit'. Suggest if it should be numeric (e.g., 'drink 8 glasses of water') or boolean (e.g., 'meditate').`,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING, enum: ["task", "project", "note", "life_area", "habit"] },
          title: { type: Type.STRING },
          priority: { type: Type.STRING, enum: ["low", "moderate", "high"] },
          life_area: { type: Type.STRING },
          original_intent: { type: Type.STRING },
          habit_config: {
            type: Type.OBJECT,
            properties: {
              type: { type: Type.STRING, enum: ["boolean", "numeric"] },
              goal: { type: Type.NUMBER },
              unit: { type: Type.STRING }
            }
          }
        },
        required: ["type", "title"]
      }
    }
  });

  return JSON.parse(response.text || '{}');
};

// --- Components ---

export default function App() {
  const [user, setUser] = useState(auth.currentUser);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<BrainDumpItem[]>([]);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [brainDump, setBrainDump] = useState('');
  const [typeFilter, setTypeFilter] = useState<ItemType | 'all'>('all');
  const [selectedItem, setSelectedItem] = useState<BrainDumpItem | null>(null);
  
  // New States
  const [isManualMode, setIsManualMode] = useState(true);
  const [manualType, setManualType] = useState<ItemType>('task');
  const [manualTitle, setManualTitle] = useState('');
  const [manualPriority, setManualPriority] = useState<Priority | ''>('');
  const [manualParentId, setManualParentId] = useState('');
  const [manualDeadline, setManualDeadline] = useState('');
  const [manualRecurrence, setManualRecurrence] = useState<'daily' | 'weekly' | 'monthly' | 'yearly' | 'none'>('none');
  const [habitType, setHabitType] = useState<'boolean' | 'numeric'>('boolean');
  const [habitGoal, setHabitGoal] = useState<number>(1);
  const [habitUnit, setHabitUnit] = useState('');
  const [currentView, setCurrentView] = useState<{ type: 'root' | 'area' | 'project' | 'calendar', id?: string }>({ type: 'root' });
  const [calendarTab, setCalendarTab] = useState<'daily' | 'weekly' | 'monthly' | 'yearly'>('daily');
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);

  // Sync manualParentId with currentView
  useEffect(() => {
    if (currentView.id) {
      setManualParentId(currentView.id);
    } else {
      setManualParentId('');
    }
  }, [currentView.id]);

  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<Partial<BrainDumpItem>>({});
  const [isBirdsEye, setIsBirdsEye] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('isDarkMode');
      return saved ? JSON.parse(saved) : window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  });

  useEffect(() => {
    localStorage.setItem('isDarkMode', JSON.stringify(isDarkMode));
    const root = window.document.documentElement;
    const body = window.document.body;
    if (isDarkMode) {
      root.classList.add('dark');
      body.classList.add('dark');
      root.setAttribute('data-theme', 'dark');
    } else {
      root.classList.remove('dark');
      body.classList.remove('dark');
      root.setAttribute('data-theme', 'light');
    }
  }, [isDarkMode]);

  // Timer State
  const [timeLeft, setTimeLeft] = useState(0);
  const [timerDuration, setTimerDuration] = useState(300); // Default 5m
  const [isTimerActive, setIsTimerActive] = useState(false);
  const [timerTaskId, setTimerTaskId] = useState('');
  const [timerHistory, setTimerHistory] = useState<any[]>([]);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isEditingTimer, setIsEditingTimer] = useState(false);
  const [isTimerSetupOpen, setIsTimerSetupOpen] = useState(false);
  const [isHabitProgressOpen, setIsHabitProgressOpen] = useState(false);
  const [historyFilterId, setHistoryFilterId] = useState<string | null>(null);
  const [timerEndTime, setTimerEndTime] = useState<number | null>(null);
  const [hasRecovered, setHasRecovered] = useState(false);
  const persistenceRef = useRef<any>(null);

  // Pre-load audio objects to ensure they are ready to play even in background
  const timerAudioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    timerAudioRef.current = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
    timerAudioRef.current.volume = 0.2;
    timerAudioRef.current.load();
  }, []);

  const requestNotificationPermission = async () => {
    if ('Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch (error) {
        console.error("Error requesting notification permission:", error);
      }
    }
  };

  // Timer Recovery from LocalStorage
  useEffect(() => {
    const saved = localStorage.getItem('ef_engine_timer');
    if (saved) {
      try {
        const data = JSON.parse(saved);
        const { endTime, duration, taskId, active } = data;
        const now = Date.now();
        if (active && endTime > now) {
          setTimerDuration(duration);
          setTimerTaskId(taskId);
          setTimerEndTime(endTime);
          const remaining = Math.max(0, Math.ceil((endTime - now) / 1000));
          setTimeLeft(remaining);
          setIsTimerActive(true);
        } else {
          localStorage.removeItem('ef_engine_timer');
        }
      } catch (e) {
        console.error("Failed to recover timer:", e);
      }
    }
    setHasRecovered(true);
  }, []);

  // Timer Persistence to LocalStorage
  useEffect(() => {
    if (!hasRecovered) return;

    if (isTimerActive && timerEndTime) {
      const data = {
        endTime: timerEndTime,
        duration: timerDuration,
        taskId: timerTaskId,
        active: true,
        lastUpdated: Date.now()
      };
      localStorage.setItem('ef_engine_timer', JSON.stringify(data));
      persistenceRef.current = data;
    } else if (hasRecovered && !isTimerActive) {
      localStorage.removeItem('ef_engine_timer');
      persistenceRef.current = null;
    }
  }, [isTimerActive, timerEndTime, timerDuration, timerTaskId, hasRecovered]);

  useEffect(() => {
    if (!user) {
      setTimerHistory([]);
      return;
    }

    const q = query(
      collection(db, 'timer_sessions'),
      where('userId', '==', user.uid)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const history = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      // Sort on client to avoid requiring composite indexes
      history.sort((a: any, b: any) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());
      setTimerHistory(history);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'timer_sessions');
    });

    return unsubscribe;
  }, [user]);

  const formatTime = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleTimerComplete = useCallback(async () => {
    if (!user) return;
    // Notify UI immediately to avoid race conditions with worker re-renders
    setIsTimerActive(false);
    setTimerEndTime(null);
    localStorage.removeItem('ef_engine_timer');

    // Show a browser notification
    if ('Notification' in window && Notification.permission === 'granted') {
      const task = items.find(i => i.id === timerTaskId);
      new Notification('Timer Complete!', {
        body: task ? `Focus session for "${task.title}" ended.` : 'Your focus session has finished.',
        tag: 'timer-complete',
        requireInteraction: true
      });
    }

    // Play a "ding" sound
    try {
      if (timerAudioRef.current) {
        timerAudioRef.current.currentTime = 0;
        timerAudioRef.current.play().catch(e => {
          console.warn("Audio ref play failed, trying fresh instance:", e);
          const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
          audio.volume = 0.2;
          audio.play().catch(() => {});
        });
      } else {
        const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
        audio.volume = 0.2;
        audio.play().catch(() => {});
      }
    } catch (error) {
      console.error("Failed to play notification sound:", error);
    }
    
    const task = items.find(i => i.id === timerTaskId);
    const session = {
      userId: user.uid,
      taskId: timerTaskId || null,
      taskTitle: task?.title || 'General Session',
      durationSeconds: timerDuration,
      completedAt: new Date().toISOString()
    };

    try {
      await addDoc(collection(db, 'timer_sessions'), session);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'timer_sessions');
    }
  }, [user, items, timerTaskId, timerDuration]);

  const startTimer = () => {
    setTimerTaskId('');
    const endTime = Date.now() + timerDuration * 1000;
    setTimerEndTime(endTime);
    setTimeLeft(timerDuration);
    setIsTimerActive(true);
    
    // Unlock audio
    if (timerAudioRef.current) {
      timerAudioRef.current.play().then(() => {
        timerAudioRef.current?.pause();
        timerAudioRef.current!.currentTime = 0;
      }).catch(() => {});
    }
  };

  const timerCompleteRef = useRef(handleTimerComplete);
  useEffect(() => {
    timerCompleteRef.current = handleTimerComplete;
  }, [handleTimerComplete]);

  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    if (isTimerActive && timerEndTime) {
      if (workerRef.current) return; // Prevent multiple workers

      const workerCode = `
        let interval;
        self.onmessage = (e) => {
          if (e.data === 'start') {
            interval = setInterval(() => self.postMessage('tick'), 1000);
          } else if (e.data === 'stop') {
            clearInterval(interval);
          }
        };
      `;
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      const worker = new Worker(workerUrl);
      workerRef.current = worker;

      worker.onmessage = () => {
        const now = Date.now();
        const remaining = Math.max(0, Math.ceil((timerEndTime - now) / 1000));
        setTimeLeft(remaining);
        
        if (remaining <= 0) {
          worker.postMessage('stop');
          timerCompleteRef.current();
        }
      };

      worker.postMessage('start');

      const handleVisibilityChange = () => {
        if (document.visibilityState === 'visible' && isTimerActive && timerEndTime) {
          const now = Date.now();
          const remaining = Math.max(0, Math.ceil((timerEndTime - now) / 1000));
          setTimeLeft(remaining);
          if (remaining <= 0) {
            timerCompleteRef.current();
          }
        }
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);

      return () => {
        worker.postMessage('stop');
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        workerRef.current = null;
      };
    }
  }, [isTimerActive, timerEndTime]);

  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, (authUser) => {
      if (authUser) {
        setUser(authUser);
        setAuthReady(true);
      } else {
        setUser(null);
        setItems([]);
        setAuthReady(true);
        setDataLoaded(true); // Don't block if not logged in
      }
      setLoading(false);
    });
    return unsubscribeAuth;
  }, []);

  useEffect(() => {
    if (!authReady || !user) {
      return;
    }

    const q = query(
      collection(db, 'items'),
      where('userId', '==', user.uid)
    );

    const unsubscribeItems = onSnapshot(q, (snapshot) => {
      const newItems = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as BrainDumpItem[];
      
      // Sort on client side to avoid index requirement
      newItems.sort((a, b) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        const diff = (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
        return diff;
      });
      
      setItems(newItems);
      setDataLoaded(true);
    }, (error) => {
      setDataLoaded(true);
      handleFirestoreError(error, OperationType.LIST, 'items');
    });

    return unsubscribeItems;
  }, [authReady, user?.uid]);

  const handleLogin = async () => {
    try {
      const result = await signInWithGoogle();
      const user = result.user;
      try {
        await setDoc(doc(db, 'users', user.uid), {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
          photoURL: user.photoURL,
          createdAt: new Date().toISOString()
        }, { merge: true });
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}`);
      }
    } catch (error) {
      console.error("Login failed:", error);
    }
  };

  const handleLogout = () => signOutUser();

  const handleSubmitDump = async () => {
    if (!brainDump.trim() || !user) return;

    setIsProcessing(true);
    try {
      const newItem: any = {
        userId: user.uid,
        createdAt: new Date().toISOString(),
        completed: false,
        subtasks: [],
        original_intent: brainDump,
        position: Date.now()
      };

      if (currentView.type !== 'root' && currentView.id) {
        newItem.parentId = currentView.id;
      }

      if (isManualMode) {
        newItem.type = manualType;
        newItem.title = manualTitle || brainDump;
        
        if (manualDeadline) {
          newItem.deadline = manualDeadline;
        }
        
        if (manualPriority) {
          newItem.priority = manualPriority;
        }

        if (manualRecurrence !== 'none') {
          newItem.recurrence = manualRecurrence;
        }

        if (manualType === 'habit') {
          newItem.habit_config = {
            type: habitType,
            goal: habitGoal,
            unit: habitUnit
          };
          newItem.habit_logs = [];
        }
        
        // Use manualParentId if provided, otherwise fallback to currentView
        const effectiveParentId = manualParentId || (currentView.type !== 'root' ? currentView.id : undefined);
        if (effectiveParentId) {
          newItem.parentId = effectiveParentId;
          const parentItem = items.find(i => i.id === effectiveParentId);
          newItem.life_area = parentItem?.type === 'life_area' ? parentItem.title : (parentItem?.life_area || '');
        } else {
          newItem.life_area = '';
        }

        newItem.subtasks = [];
        
        await addDoc(collection(db, 'items'), newItem);
        setManualTitle('');
        setManualPriority('');
        setManualParentId(currentView.id || '');
        setManualDeadline('');
        setManualRecurrence('none');
        setHabitUnit('');
        setHabitGoal(1);
      } else {
        const processed = await processBrainDump(brainDump);
        Object.assign(newItem, processed);
        newItem.subtasks = [];
        await addDoc(collection(db, 'items'), newItem);
      }
      setBrainDump('');
    } catch (error) {
      console.error("Processing failed:", error);
      handleFirestoreError(error, OperationType.CREATE, 'items');
    } finally {
      setIsProcessing(false);
    }
  };

  const quickAddTask = async (title: string, deadline?: string, scope?: 'daily' | 'weekly' | 'monthly' | 'yearly') => {
    if (!title.trim() || !user) return;
    try {
      const newItem: any = {
        userId: user.uid,
        type: 'task',
        title: title.trim(),
        createdAt: new Date().toISOString(),
        completed: false,
        subtasks: [],
        original_intent: title,
        position: Date.now()
      };
      if (deadline) newItem.deadline = deadline;
      if (scope) newItem.scope = scope;
      
      // If we are in a specific view, inherit parent
      if (currentView.id) {
        newItem.parentId = currentView.id;
        const parentItem = items.find(i => i.id === currentView.id);
        newItem.life_area = parentItem?.type === 'life_area' ? parentItem.title : (parentItem?.life_area || '');
      }

      await addDoc(collection(db, 'items'), newItem);
      playTickSound(); // Feedback for adding
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'items');
    }
  };

  const playTickSound = () => {
    console.log("Attempting to play tick sound...");
    try {
      // Using a clear "ding" sound, slightly louder than before but still less than timer (0.2)
      const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2568/2568-preview.mp3');
      audio.volume = 0.15;
      audio.play().catch(e => {
        console.warn("Audio play blocked or failed, trying fallback:", e);
        // Fallback to the other success sound if the first one fails
        const fallback = new Audio('https://assets.mixkit.co/active_storage/sfx/2571/2571-preview.mp3');
        fallback.volume = 0.15;
        fallback.play().catch(() => {});
      });
    } catch (error) {
      console.error("Failed to play tick sound:", error);
    }
  };

  const toggleComplete = async (item: BrainDumpItem) => {
    if (item.type === 'note') return;
    try {
      const newStatus = !item.completed;
      if (newStatus) playTickSound();
      
      await updateDoc(doc(db, 'items', item.id), {
        completed: newStatus,
        completedAt: newStatus ? new Date().toISOString() : null
      });

      // Handle Recurrence
      if (newStatus && item.recurrence && item.recurrence !== 'none') {
        const nextDeadline = new Date(item.deadline || item.createdAt);
        
        switch (item.recurrence) {
          case 'daily':
            nextDeadline.setDate(nextDeadline.getDate() + 1);
            break;
          case 'weekly':
            nextDeadline.setDate(nextDeadline.getDate() + 7);
            break;
          case 'monthly':
            nextDeadline.setMonth(nextDeadline.getMonth() + 1);
            break;
          case 'yearly':
            nextDeadline.setFullYear(nextDeadline.getFullYear() + 1);
            break;
        }

        const { id, ...itemData } = item;
        await addDoc(collection(db, 'items'), {
          ...itemData,
          completed: false,
          completedAt: null,
          createdAt: new Date().toISOString(),
          deadline: nextDeadline.toISOString(),
          position: Date.now()
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `items/${item.id}`);
    }
  };

  const deleteItem = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'items', id));
      if (selectedItem?.id === id) setSelectedItem(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `items/${id}`);
    }
  };

  const handleUpdateItem = async () => {
    if (!selectedItem || !editForm.title) return;
    try {
      // Remove undefined values
      const cleanUpdate = Object.fromEntries(
        Object.entries(editForm).filter(([_, v]) => v !== undefined)
      );
      await updateDoc(doc(db, 'items', selectedItem.id), cleanUpdate);
      setSelectedItem({ ...selectedItem, ...cleanUpdate } as BrainDumpItem);
      setIsEditing(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `items/${selectedItem.id}`);
    }
  };

  const addSubtask = async (title: string) => {
    if (!selectedItem || !title.trim()) return;
    const newSubtask: Subtask = {
      id: Math.random().toString(36).substr(2, 9),
      title,
      completed: false
    };
    const updatedSubtasks = [...(selectedItem.subtasks || []), newSubtask];
    try {
      await updateDoc(doc(db, 'items', selectedItem.id), { subtasks: updatedSubtasks });
      setSelectedItem({ ...selectedItem, subtasks: updatedSubtasks });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `items/${selectedItem.id}`);
    }
  };

  const addLinkedNote = async (title: string) => {
    if (!selectedItem || !title.trim() || !user) return;
    try {
      const newNote: any = {
        userId: user.uid,
        type: 'note',
        title,
        parentId: selectedItem.id,
        createdAt: new Date().toISOString(),
        completed: false,
        subtasks: [],
        original_intent: '',
        life_area: selectedItem.type === 'life_area' ? selectedItem.title : (selectedItem.life_area || '')
      };
      await addDoc(collection(db, 'items'), newNote);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'items');
    }
  };

  const toggleSubtask = async (subtaskId: string) => {
    if (!selectedItem) return;
    let playedSound = false;
    const updatedSubtasks = selectedItem.subtasks.map(st => {
      if (st.id === subtaskId) {
        const newStatus = !st.completed;
        if (newStatus && !playedSound) {
          playTickSound();
          playedSound = true;
        }
        return { ...st, completed: newStatus };
      }
      return st;
    });
    try {
      await updateDoc(doc(db, 'items', selectedItem.id), { subtasks: updatedSubtasks });
      setSelectedItem({ ...selectedItem, subtasks: updatedSubtasks });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `items/${selectedItem.id}`);
    }
  };

  const logHabit = async (item: BrainDumpItem, value: number | boolean, dateStr?: string) => {
    const targetDate = dateStr || new Date().toISOString().split('T')[0];
    const logs = [...(item.habit_logs || [])];
    const existingIndex = logs.findIndex(l => l.date === targetDate);
    
    // Ding if we are setting a positive value or checking a box
    if (value === true || (typeof value === 'number' && value > 0)) {
      playTickSound();
    }

    if (existingIndex >= 0) {
      logs[existingIndex] = { 
        date: targetDate, 
        value,
        timestamp: (value === true || (typeof value === 'number' && value > 0)) ? new Date().toISOString() : logs[existingIndex].timestamp
      };
    } else {
      logs.push({ 
        date: targetDate, 
        value,
        timestamp: (value === true || (typeof value === 'number' && value > 0)) ? new Date().toISOString() : undefined
      });
    }

    try {
      await updateDoc(doc(db, 'items', item.id), { habit_logs: logs });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `items/${item.id}`);
    }
  };

  const getLast7Days = () => {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().split('T')[0]);
    }
    return days;
  };

  // Filtering Logic
  const visibleItems = useMemo(() => {
    if (!items) return [];

    let baseItems = items;
    
    if (currentView.type === 'root') {
      if (typeFilter === 'all') {
        // Show everything that doesn't have a parent (orphans) + Life Areas
        baseItems = items.filter(i => i.type === 'life_area' || !i.parentId);
      } else {
        // When a specific type filter is selected, show all items of that type
        baseItems = items.filter(i => i.type === typeFilter);
      }
    } else {
      // Inside an area or project: show children and apply type filter
      if (currentView.type === 'area' && (typeFilter === 'task' || typeFilter === 'habit' || typeFilter === 'note')) {
        // For area views, we want to show items that belong to projects within this area too
        const areaItem = items.find(it => it.id === currentView.id);
        const areaProjectIds = items.filter(it => it.parentId === currentView.id && it.type === 'project').map(it => it.id);
        
        baseItems = items.filter(i => 
          i.parentId === currentView.id || 
          (i.parentId && areaProjectIds.includes(i.parentId)) ||
          (areaItem && i.life_area === areaItem.title)
        );
      } else {
        baseItems = items.filter(i => i.parentId === currentView.id);
      }
      
      if (typeFilter !== 'all') {
        baseItems = baseItems.filter(item => item && item.type === typeFilter);
      }
    }

    // Sort by priority (High > Moderate > Low > None), then position desc, then createdAt desc
    return [...baseItems].sort((a, b) => {
      const priorityOrder = { high: 3, moderate: 2, low: 1 };
      const priorityA = a?.priority ? (priorityOrder[a.priority as keyof typeof priorityOrder] || 0) : 0;
      const priorityB = b?.priority ? (priorityOrder[b.priority as keyof typeof priorityOrder] || 0) : 0;
      
      if (priorityA !== priorityB) return priorityB - priorityA;

      const posA = a?.position ?? 0;
      const posB = b?.position ?? 0;
      if (posA !== posB) return posB - posA;
      const timeB = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
      const timeA = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
      return (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
    });
  }, [items, currentView, typeFilter]);

  const handleReorder = async (newOrder: BrainDumpItem[]) => {
    // To minimize writes, we only update the position field.
    // We want the items to stay in the order they were dropped.
    // We'll assign positions based on the new index.
    const updates = newOrder.map((item, index) => {
      const newPos = (newOrder.length - index) * 100;
      if (item.position !== newPos) {
        return updateDoc(doc(db, 'items', item.id), { position: newPos });
      }
      return null;
    }).filter(Boolean);

    if (updates.length > 0) {
      try {
        await Promise.all(updates);
      } catch (error) {
        console.error("Reorder failed:", error);
      }
    }
  };

  const itemsByParent = useMemo(() => {
    const map: Record<string, BrainDumpItem[]> = {};
    items.forEach(item => {
      const pId = item.parentId || 'root';
      if (!map[pId]) map[pId] = [];
      map[pId].push(item);
    });
    return map;
  }, [items]);

  const lifeAreas = useMemo(() => {
    return (items || [])
      .filter(i => i && i.type === 'life_area')
      .sort((a, b) => {
        const posA = a?.position ?? 0;
        const posB = b?.position ?? 0;
        if (posA !== posB) return posB - posA;
        const timeB = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
        const timeA = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
        return (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
      });
  }, [items]);

  const projects = useMemo(() => {
    return (items || [])
      .filter(i => i && i.type === 'project')
      .sort((a, b) => {
        const posA = a?.position ?? 0;
        const posB = b?.position ?? 0;
        if (posA !== posB) return posB - posA;
        const timeB = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
        const timeA = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
        return (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
      });
  }, [items]);

  const currentItem = useMemo(() => 
    (currentView.id && items) ? items.find(i => i.id === currentView.id) : null
  , [items, currentView.id]);

  const timeProgress = useMemo(() => {
    const now = new Date();
    
    // Daily
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const dayElapsed = now.getTime() - dayStart;
    const dayProgress = (dayElapsed / (24 * 60 * 60 * 1000)) * 100;

    // Weekly
    const dayOfWeek = now.getDay();
    const weekOffset = (dayOfWeek - 5 + 7) % 7; // Start on Friday (5)
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - weekOffset).getTime();
    const weekElapsed = now.getTime() - weekStart;
    const weekProgress = (weekElapsed / (7 * 24 * 60 * 60 * 1000)) * 100;

    // Monthly
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    const monthDuration = nextMonthStart - monthStart;
    const monthElapsed = now.getTime() - monthStart;
    const monthProgress = (monthElapsed / monthDuration) * 100;

    // Yearly
    const yearStart = new Date(now.getFullYear(), 0, 1).getTime();
    const nextYearStart = new Date(now.getFullYear() + 1, 0, 1).getTime();
    const yearDuration = nextYearStart - yearStart;
    const yearElapsed = now.getTime() - yearStart;
    const yearProgress = (yearElapsed / yearDuration) * 100;

    return {
      daily: dayProgress,
      weekly: weekProgress,
      monthly: monthProgress,
      yearly: yearProgress,
      timeLeft: {
        daily: Math.max(0, (dayEnd - now.getTime()) / (60 * 60 * 1000)), // hours
        weekly: Math.max(0, (weekStart + 7 * 24 * 60 * 60 * 1000 - now.getTime()) / (24 * 60 * 60 * 1000)), // days
        monthly: Math.max(0, (nextMonthStart - now.getTime()) / (24 * 60 * 60 * 1000)), // days
        yearly: Math.max(0, (nextYearStart - now.getTime()) / (24 * 60 * 60 * 1000)) // days
      }
    };
  }, [items]); // Update when items change or periodically (could use a timer but useMemo is fine for now)

  const archiveItems = useMemo(() => {
    const now = new Date();
    return items.filter(item => {
      if (item.type === 'life_area') return false;
      
      const itemDate = item.deadline ? new Date(item.deadline) : new Date(item.createdAt);
      const completedDate = item.completedAt ? new Date(item.completedAt) : null;
      
      const isInPeriod = (date: Date) => {
        if (calendarTab === 'daily') {
          return date.toDateString() === now.toDateString();
        }
        if (calendarTab === 'weekly') {
          const dayOfWeek = now.getDay();
          const offset = (dayOfWeek - 5 + 7) % 7;
          const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
          const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
          return date >= weekStart && date < weekEnd;
        }
        if (calendarTab === 'monthly') {
          return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
        }
        if (calendarTab === 'yearly') {
          return date.getFullYear() === now.getFullYear();
        }
        return false;
      };

      const hasHabitLogInPeriod = item.type === 'habit' && item.habit_logs?.some(log => {
        if (!log.timestamp) return false;
        const logDate = new Date(log.timestamp);
        return isInPeriod(logDate) && (log.value === true || (typeof log.value === 'number' && log.value > 0));
      });

      return isInPeriod(itemDate) || (completedDate && isInPeriod(completedDate)) || hasHabitLogInPeriod;
    }).sort((a, b) => {
      const getLatestTime = (item: BrainDumpItem) => {
        const times = [];
        if (item.completedAt) times.push(new Date(item.completedAt).getTime());
        if (item.deadline) times.push(new Date(item.deadline).getTime());
        times.push(new Date(item.createdAt).getTime());
        
        if (item.type === 'habit' && item.habit_logs) {
          item.habit_logs.forEach(l => {
            if (l.timestamp) times.push(new Date(l.timestamp).getTime());
          });
        }
        return Math.max(...times);
      };
      return getLatestTime(b) - getLatestTime(a);
    });
  }, [items, calendarTab]);

  const periodDeadlines = useMemo(() => {
    const now = new Date();
    const daily = `${getLocalDateString(now)}T23:59:59`;
    const dayOfWeek = now.getDay();
    // Offset for week start (Friday = 5)
    const offset = (dayOfWeek - 5 + 7) % 7;
    const weekStartObj = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    weekStartObj.setHours(0, 0, 0, 0);
    const weekEndObj = new Date(weekStartObj.getTime() + 6 * 24 * 60 * 60 * 1000);
    const weekly = `${getLocalDateString(weekEndObj)}T23:59:59`;
    const monthStartObj = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEndObj = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const monthly = `${getLocalDateString(monthEndObj)}T23:59:59`;
    const yearStartObj = new Date(now.getFullYear(), 0, 1);
    const yearEndObj = new Date(now.getFullYear(), 11, 31);
    const yearly = `${getLocalDateString(yearEndObj)}T23:59:59`;
    
    return { 
      daily, 
      weekly, 
      monthly, 
      yearly,
      weekStartHours: weekStartObj.getTime(),
      weekEndHours: new Date(weekly).getTime(),
      monthStartHours: monthStartObj.getTime(),
      monthEndHours: new Date(monthly).getTime(),
      yearStartHours: yearStartObj.getTime(),
      yearEndHours: new Date(yearly).getTime()
    };
  }, []);

  const periodFilters = {
    daily: (i: BrainDumpItem) => {
      if (i.scope !== 'daily') return false;
      const todayStr = periodDeadlines.daily.split('T')[0];
      const isToday = i.deadline ? i.deadline.startsWith(todayStr) : true;
      if (!isToday) return false;
      
      if (i.completed && i.completedAt) {
        const todayStart = new Date();
        todayStart.setHours(0,0,0,0);
        if (new Date(i.completedAt).getTime() < todayStart.getTime()) return false;
      }
      return true;
    },
    weekly: (i: BrainDumpItem) => {
      if (i.scope !== 'weekly') return false;
      if (i.deadline) {
        const dTime = new Date(i.deadline).getTime();
        if (dTime < periodDeadlines.weekStartHours || dTime > periodDeadlines.weekEndHours) return false;
      }
      if (i.completed && i.completedAt) {
        if (new Date(i.completedAt).getTime() < periodDeadlines.weekStartHours) return false;
      }
      return true;
    },
    monthly: (i: BrainDumpItem) => {
      if (i.scope !== 'monthly') return false;
      if (i.deadline) {
        const dTime = new Date(i.deadline).getTime();
        if (dTime < periodDeadlines.monthStartHours || dTime > periodDeadlines.monthEndHours) return false;
      }
      if (i.completed && i.completedAt) {
        if (new Date(i.completedAt).getTime() < periodDeadlines.monthStartHours) return false;
      }
      return true;
    },
    yearly: (i: BrainDumpItem) => {
      if (i.scope !== 'yearly') return false;
      if (i.deadline) {
        const dTime = new Date(i.deadline).getTime();
        if (dTime < periodDeadlines.yearStartHours || dTime > periodDeadlines.yearEndHours) return false;
      }
      if (i.completed && i.completedAt) {
        if (new Date(i.completedAt).getTime() < periodDeadlines.yearStartHours) return false;
      }
      return true;
    }
  };

  const PeriodChecklist = ({ title, placeholder, deadline, scope, filterFn }: { 
    title: string, 
    placeholder: string, 
    deadline: string, 
    scope: 'daily' | 'weekly' | 'monthly' | 'yearly', 
    filterFn: (i: BrainDumpItem) => boolean 
  }) => {
    const [inputValue, setInputValue] = useState('');
    const periodItems = items
      .filter(i => {
        if (i.type === 'life_area' || i.type === 'project') return false;
        return filterFn(i);
      })
      .sort((a, b) => {
        if (a.completed === b.completed) return 0;
        return a.completed ? 1 : -1;
      });

    const overdueItems = items
      .filter(i => {
        if (i.type === 'life_area' || i.type === 'project' || i.completed) return false;
        if (i.scope !== scope || !i.deadline) return false;
        
        const dTime = new Date(i.deadline).getTime();
        let startBound = 0;
        if (scope === 'daily') {
          const todayStart = new Date(); todayStart.setHours(0,0,0,0);
          startBound = todayStart.getTime();
        } else if (scope === 'weekly') {
          startBound = periodDeadlines.weekStartHours;
        } else if (scope === 'monthly') {
          startBound = periodDeadlines.monthStartHours;
        } else if (scope === 'yearly') {
          startBound = periodDeadlines.yearStartHours;
        }
        
        return dTime < startBound;
      })
      .sort((a, b) => {
        return new Date(b.deadline!).getTime() - new Date(a.deadline!).getTime();
      });

    const handleAdd = () => {
      if (inputValue.trim()) {
        quickAddTask(inputValue, deadline, scope);
        setInputValue('');
      }
    };

    const rescheduleItem = async (item: BrainDumpItem) => {
      try {
        await updateDoc(doc(db, 'items', item.id), { deadline });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `items/${item.id}`);
      }
    };

    const discardItem = (item: BrainDumpItem) => {
      deleteItem(item.id);
    };

    return (
      <div className="space-y-4 mb-8">
        <h3 className="font-bold text-xl dark:text-white flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-indigo-500" />
          {title}
        </h3>
        <div className="grid gap-3">
          <div className="relative">
            <input 
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={placeholder}
              className="w-full p-4 bg-white dark:bg-slate-900 rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-800 text-sm font-bold focus:border-indigo-500 focus:ring-0 outline-none transition-all dark:text-white"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleAdd();
                }
              }}
            />
            <button 
              onClick={handleAdd}
              className="absolute right-4 top-1/2 -translate-y-1/2 p-1 hover:text-indigo-500 transition-colors"
            >
              <Plus className="w-4 h-4 text-slate-400" />
            </button>
          </div>
          {periodItems.map(item => (
            <div 
              key={`period-${item.id}`}
              className={cn(
                "flex items-center gap-4 p-4 rounded-2xl border transition-all cursor-pointer",
                item.priority ? getPriorityClasses(item.priority) : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800",
                "group hover:border-indigo-200 dark:hover:border-indigo-900"
              )}
              onClick={() => setSelectedItem(item)}
            >
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  toggleComplete(item);
                }}
                className="w-6 h-6 rounded-lg border-2 border-slate-200 dark:border-slate-700 flex items-center justify-center hover:border-indigo-500 transition-colors"
              >
                {item.completed && <CheckCircle2 className="w-4 h-4 text-indigo-500" />}
              </button>
              <div className="flex-1 min-w-0">
                <span className={cn("font-bold text-slate-700 dark:text-slate-200", item.completed && "line-through opacity-50 truncate block")}>{item.title}</span>
                {item.time_budget && !item.completed && (
                  <div className="mt-1 space-y-0.5">
                    <div className="flex justify-between items-center text-[8px] font-black uppercase tracking-wider">
                      <span className="text-slate-400">Budget</span>
                      {(() => {
                        const spent = timerHistory
                          .filter(s => s.taskId === item.id)
                          .reduce((acc, s) => acc + (s.durationSeconds || 0), 0);
                        return (
                          <span className={spent > item.time_budget ? "text-red-500" : "text-indigo-500"}>
                            {Math.round((spent / item.time_budget) * 100)}%
                          </span>
                        );
                      })()}
                    </div>
                    <div className="h-0.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                      {(() => {
                        const spent = timerHistory
                          .filter(s => s.taskId === item.id)
                          .reduce((acc, s) => acc + (s.durationSeconds || 0), 0);
                        const progress = Math.min((spent / item.time_budget) * 100, 100);
                        return (
                          <div 
                            className={cn("h-full rounded-full", spent > item.time_budget ? "bg-red-500" : "bg-indigo-500")}
                            style={{ width: `${progress}%` }}
                          />
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isTimerActive && timerTaskId === item.id ? (
                  <div className="flex items-center gap-2 px-2 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-full animate-pulse">
                    <Clock className="w-3 h-3" />
                    <span className="text-[10px] font-black font-mono">{formatTime(timeLeft)}</span>
                  </div>
                ) : (
                  !item.completed && (
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedItem(item);
                        setIsTimerSetupOpen(true);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-2 bg-slate-100 dark:bg-slate-800 rounded-xl text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 transition-all"
                      title="Start Timer"
                    >
                      <Zap className="w-4 h-4" />
                    </button>
                  )
                )}
              </div>
            </div>
          ))}

          {overdueItems.length > 0 && (
            <>
              <div className="relative py-8">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t-2 border-dashed border-rose-100 dark:border-rose-900/30" />
                </div>
                <div className="relative flex justify-center">
                  <div className="bg-slate-50 dark:bg-slate-950 px-4 flex items-center gap-2 text-rose-500">
                    <AlertCircle className="w-4 h-4" />
                    <span className="text-[10px] font-black uppercase tracking-[0.2em]">Overdue Tasks</span>
                  </div>
                </div>
              </div>
              {overdueItems.map(item => (
                <div 
                  key={`overdue-${item.id}`}
                  className={cn(
                    "flex items-center gap-4 p-4 rounded-2xl border transition-all bg-rose-50/30 dark:bg-rose-900/10 border-rose-100 dark:border-rose-900/20 group hover:border-rose-300"
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-700 dark:text-slate-200">{item.title}</span>
                      <span className="text-[10px] font-black text-rose-400 uppercase tracking-widest px-2 py-0.5 bg-rose-100/50 dark:bg-rose-900/50 rounded-full">
                        {new Date(item.deadline!).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={() => rescheduleItem(item)}
                      className="flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-slate-800 rounded-xl text-xs font-black text-indigo-600 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-900/50 hover:bg-indigo-50 transition-all shadow-sm shadow-indigo-100/20"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Keep
                    </button>
                    <button 
                      onClick={() => discardItem(item)}
                      className="flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-slate-800 rounded-xl text-xs font-black text-slate-400 dark:text-slate-500 border border-slate-100 dark:border-slate-800 hover:text-rose-500 hover:border-rose-200 transition-all"
                    >
                      <Trash2 className="w-3 h-3" />
                      Discard
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          {periodItems.length === 0 && overdueItems.length === 0 && (
            <div className="text-center py-12 bg-slate-50/50 dark:bg-slate-900/50 rounded-3xl border border-dashed border-slate-200 dark:border-slate-800">
              <p className="text-slate-400 font-medium italic">No tasks for this period. Add one to get started!</p>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderHabitsProgress = () => {
    const habits = items.filter(i => i.type === 'habit');
    if (habits.length === 0) return null;

    const priorityWeight = (p?: Priority) => {
      if (p === 'high') return 3;
      if (p === 'moderate') return 2;
      if (p === 'low') return 1;
      return 0;
    };

    const sortedHabits = [...habits].sort((a, b) => {
      const weightA = priorityWeight(a.priority);
      const weightB = priorityWeight(b.priority);
      if (weightA !== weightB) return weightB - weightA;
      return a.life_area.localeCompare(b.life_area);
    });

    return (
      <div className="mt-12 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-100 dark:bg-indigo-900/30 rounded-2xl flex items-center justify-center text-indigo-600">
            <Repeat className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-xl font-black text-slate-900 dark:text-white">Habit Progress</h3>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Performance for this {calendarTab}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sortedHabits.map(habit => {
            const logs = habit.habit_logs || [];
            const now = new Date();
            let periodLogs = [];

            if (calendarTab === 'daily') {
              periodLogs = logs.filter(l => l.date === now.toISOString().split('T')[0]);
            } else if (calendarTab === 'weekly') {
              const dayOfWeek = now.getDay();
              const offset = (dayOfWeek - 5 + 7) % 7;
              const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
              weekStart.setHours(0, 0, 0, 0);
              const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
              periodLogs = logs.filter(l => {
                const d = new Date(l.date);
                return d >= weekStart && d < weekEnd;
              });
            } else if (calendarTab === 'monthly') {
              periodLogs = logs.filter(l => {
                const d = new Date(l.date);
                return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
              });
            } else if (calendarTab === 'yearly') {
              periodLogs = logs.filter(l => {
                const d = new Date(l.date);
                return d.getFullYear() === now.getFullYear();
              });
            }

            const completedCount = periodLogs.filter(l => 
              l.value === true || (typeof l.value === 'number' && l.value > 0)
            ).length;

            let totalExpected = 1;
            if (calendarTab === 'weekly') totalExpected = 7;
            if (calendarTab === 'monthly') totalExpected = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
            if (calendarTab === 'yearly') totalExpected = 365;

            const isCompletedToday = logs.some(l => 
              l.date === now.toISOString().split('T')[0] && 
              (l.value === true || (typeof l.value === 'number' && l.value > 0))
            );

            const progress = Math.min(Math.round((completedCount / totalExpected) * 100), 100);

            return (
              <div 
                key={`habit-progress-${habit.id}`} 
                onClick={() => setSelectedItem(habit)}
                className={cn(
                  "p-5 rounded-3xl border shadow-sm transition-all flex flex-col cursor-pointer",
                  habit.priority ? getPriorityClasses(habit.priority) : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800",
                  "hover:border-indigo-200 dark:hover:border-indigo-900"
                )}
              >
                <div className="flex justify-between items-start mb-4">
                  <div className="flex items-start gap-3">
                    {calendarTab === 'daily' && (
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          const today = now.toISOString().split('T')[0];
                          const log = logs.find(l => l.date === today);
                          if (habit.habit_config?.type === 'numeric') {
                            const goal = habit.habit_config.goal || 1;
                            const currentVal = typeof log?.value === 'number' ? log.value : 0;
                            logHabit(habit, currentVal >= goal ? 0 : goal, today);
                          } else {
                            logHabit(habit, !log?.value, today);
                          }
                        }}
                        className={cn(
                          "w-6 h-6 rounded-lg border-2 flex-shrink-0 flex items-center justify-center transition-all",
                          isCompletedToday 
                            ? "bg-indigo-600 border-indigo-600 text-white" 
                            : "border-slate-200 dark:border-slate-700 hover:border-indigo-500"
                        )}
                      >
                        {isCompletedToday && <CheckCircle2 className="w-4 h-4" />}
                      </button>
                    )}
                    <div>
                      <div className="text-[10px] font-black text-indigo-500 uppercase tracking-widest mb-1">{habit.life_area}</div>
                      <h4 className="font-bold text-slate-900 dark:text-white">{habit.title}</h4>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-black text-indigo-600 dark:text-indigo-400">{progress}%</div>
                    <div className="text-[10px] font-bold text-slate-400">{completedCount} / {totalExpected}</div>
                  </div>
                </div>
                <div className="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden mt-auto">
                  <motion.div 
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    className="h-full bg-indigo-500"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderSingleHabitProgress = (item: BrainDumpItem) => {
    if (item.type !== 'habit') return null;
    
    const logs = item.habit_logs || [];
    const isNumeric = item.habit_config?.type === 'numeric';
    
    const getWeeklyScore = (startDate: Date) => {
      const { start, end } = getHabitWeekRange(startDate);
      const weekLogs = logs.filter(l => {
        const logDate = new Date(l.date);
        return logDate >= start && logDate <= end;
      });
      
      if (isNumeric) {
        return weekLogs.reduce((sum, l) => sum + (Number(l.value) || 0), 0);
      } else {
        return weekLogs.filter(l => l.value === true).length;
      }
    };

    const currentWeekScore = getWeeklyScore(new Date());
    
    const lastWeekDate = new Date();
    lastWeekDate.setDate(lastWeekDate.getDate() - 7);
    const lastWeekScore = getWeeklyScore(lastWeekDate);

    const twoWeeksAgoDate = new Date();
    twoWeeksAgoDate.setDate(twoWeeksAgoDate.getDate() - 14);
    const twoWeeksAgoScore = getWeeklyScore(twoWeeksAgoDate);

    const heatmapDays = [];
    const today = new Date();
    for (let i = 55; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const log = logs.find(l => l.date === dateStr);
      heatmapDays.push({
        date: dateStr,
        value: log ? log.value : null,
      });
    }

    return (
      <motion.div 
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        className="p-6 bg-indigo-50 dark:bg-indigo-900/10 rounded-3xl border border-indigo-100 dark:border-indigo-900/30 space-y-6 mb-6"
      >
        <div className="flex items-center justify-between">
          <h3 className="font-black text-indigo-900 dark:text-indigo-100 flex items-center gap-2">
            <Activity className="w-5 h-5" />
            Habit Progress
          </h3>
          {isNumeric && (
            <div className="text-xs font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-widest">
              Goal: {item.habit_config?.goal} {item.habit_config?.unit}
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="p-3 bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-indigo-50 dark:border-indigo-900/50 text-center">
            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">This Week</div>
            <div className="text-xl font-black text-indigo-600 dark:text-indigo-400">{currentWeekScore}</div>
            <div className="text-[8px] font-bold text-slate-400 uppercase tracking-tighter">Fri - Thu</div>
          </div>
          <div className="p-3 bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-indigo-50 dark:border-indigo-900/50 text-center">
            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Last Week</div>
            <div className="text-xl font-black text-slate-600 dark:text-slate-300">{lastWeekScore}</div>
          </div>
          <div className="p-3 bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-indigo-50 dark:border-indigo-900/50 text-center">
            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">2 Weeks Ago</div>
            <div className="text-xl font-black text-slate-600 dark:text-slate-300">{twoWeeksAgoScore}</div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex justify-between">
            <span>Last 8 Weeks</span>
            <span>{logs.length} total logs</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {heatmapDays.map((d, i) => {
              let colorClass = "bg-slate-200 dark:bg-slate-800";
              if (d.value === true) colorClass = "bg-indigo-500";
              else if (typeof d.value === 'number' && d.value > 0) {
                const intensity = Math.min(Math.floor((d.value / (item.habit_config?.goal || 1)) * 4), 4);
                const colors = [
                  "bg-indigo-100 dark:bg-indigo-900/30",
                  "bg-indigo-200 dark:bg-indigo-800/50",
                  "bg-indigo-300 dark:bg-indigo-700/70",
                  "bg-indigo-400 dark:bg-indigo-600/90",
                  "bg-indigo-500"
                ];
                colorClass = colors[intensity];
              }
              
              return (
                <div 
                  key={i} 
                  className={cn("w-3 h-3 rounded-sm transition-all hover:scale-125 cursor-help", colorClass)}
                  title={`${d.date}: ${d.value ?? 'No log'}`}
                />
              );
            })}
          </div>
        </div>
      </motion.div>
    );
  };

  if (loading || (user && !dataLoaded)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 transition-colors duration-300">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600 dark:text-indigo-400" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 dark:bg-slate-950 p-4 transition-colors duration-300">
        <div className="max-w-md w-full text-center space-y-8">
          <div className="flex justify-center">
            <div className="w-20 h-20 bg-indigo-600 rounded-3xl flex items-center justify-center shadow-xl rotate-3">
              <Brain className="w-12 h-12 text-white" />
            </div>
          </div>
          <div className="space-y-2">
            <h1 className="text-4xl font-bold tracking-tight text-slate-900 dark:text-white">Executive Function Engine</h1>
            <p className="text-slate-500 dark:text-slate-400 text-lg">Your Second Brain for ADHD. Stop overthinking, start doing.</p>
          </div>
          <button
            onClick={handleLogin}
            className="w-full flex items-center justify-center gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 px-6 py-4 rounded-2xl font-semibold shadow-sm hover:bg-slate-50 dark:hover:bg-slate-800 transition-all active:scale-95"
          >
            <LogIn className="w-5 h-5" />
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans pb-20 flex flex-col md:flex-row transition-colors duration-300">
      {/* Sidebar - Life Areas & Projects */}
      <aside className="w-full md:w-72 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex-shrink-0 overflow-y-auto hidden md:block transition-colors duration-300">
        <div className="p-6 space-y-8">
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-2">
              <Brain className="w-6 h-6 text-indigo-600" />
              <span className="font-bold text-xl tracking-tight">EF Engine</span>
            </div>
            <button 
              onClick={() => setIsDarkMode(!isDarkMode)}
              className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
            >
              {isDarkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>

          <nav className="space-y-6">
            <div className="space-y-2">
              <h3 className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest px-2">Navigation</h3>
              <button 
                onClick={() => {
                  setCurrentView({ type: 'root' });
                  setIsBirdsEye(false);
                }}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-xl font-bold transition-all",
                  currentView.type === 'root' ? "bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400" : "text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
                )}
              >
                <Layout className="w-4 h-4" />
                Dashboard
              </button>
              <button 
                onClick={() => {
                  setCurrentView({ type: 'calendar' });
                  setIsBirdsEye(false);
                }}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-xl font-bold transition-all",
                  currentView.type === 'calendar' ? "bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400" : "text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
                )}
              >
                <Calendar className="w-4 h-4" />
                Calendar
              </button>
            </div>

            <div className="space-y-2">
              <h3 className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest px-2">Life Areas</h3>
              <Reorder.Group axis="y" values={lifeAreas} onReorder={handleReorder} className="space-y-1">
                {lifeAreas.map(area => (
                  <Reorder.Item 
                    key={area.id} 
                    value={area}
                    className="relative group/sidebar"
                  >
                    <div className="absolute -left-2 top-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing text-slate-300 dark:text-slate-700 hover:text-slate-400 transition-colors opacity-0 group-hover/sidebar:opacity-100 shrink-0">
                      <GripVertical className="w-3 h-3" />
                    </div>
                    <button 
                      onClick={() => {
                        setCurrentView({ type: 'area', id: area.id });
                        setIsBirdsEye(false);
                      }}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2 rounded-xl font-bold transition-all truncate text-left",
                        currentView.id === area.id ? "bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400" : "text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
                      )}
                    >
                      <Folder className="w-4 h-4 text-indigo-400 shrink-0" />
                      <span className="truncate">{area.title}</span>
                    </button>
                  </Reorder.Item>
                ))}
              </Reorder.Group>
            </div>
          </nav>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-h-screen">
        {/* Header */}
        <header className="sticky top-0 z-30 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 md:hidden transition-colors duration-300">
          <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Brain className="w-6 h-6 text-indigo-600" />
              <span className="font-bold text-xl tracking-tight text-slate-900 dark:text-white">EF Engine</span>
            </div>
            <div className="flex items-center gap-2">
              <button 
                onClick={() => setIsDarkMode(!isDarkMode)}
                className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
                title={isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
              >
                {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>
              <button 
                onClick={handleLogout}
                className="p-2 text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                title="Log Out"
              >
                <LogOut className="w-5 h-5" />
              </button>
              <img 
                src={user.photoURL || ''} 
                alt={user.displayName || ''} 
                className="w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700"
                referrerPolicy="no-referrer"
              />
              <button 
                onClick={handleLogout}
                className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
              >
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          </div>
        </header>

        <main className="max-w-4xl mx-auto w-full px-4 py-8 space-y-12">
          {/* Breadcrumbs / View Title & Toggle */}
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-slate-400 text-sm font-bold uppercase tracking-widest">
                <button 
                  onClick={() => {
                    setCurrentView({ type: 'root' });
                    setIsBirdsEye(false);
                  }} 
                  className="hover:text-indigo-600"
                >
                  Home
                </button>
                {(currentItem || currentView.type === 'calendar') && (
                  <>
                    <ChevronRight className="w-4 h-4" />
                    <span className="text-indigo-600">{currentView.type === 'calendar' ? 'Calendar' : currentItem?.title}</span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-4">
                <h1 className="text-3xl font-black text-slate-900 dark:text-white">
                  {isBirdsEye ? "Bird's Eye View" : (currentView.type === 'calendar' ? "Calendar" : (currentItem ? (currentView.type === 'area' ? `Area: ${currentItem.title}` : `Project: ${currentItem.title}`) : "Dashboard"))}
                </h1>
                {!isBirdsEye && currentItem && (
                  <div className="flex items-center gap-1">
                    <button 
                      onClick={() => {
                        setSelectedItem(currentItem);
                        setIsEditing(true);
                        setEditForm(currentItem);
                      }}
                      className="p-2 text-slate-400 hover:text-indigo-600 transition-colors"
                      title="Edit"
                    >
                      <Edit3 className="w-5 h-5" />
                    </button>
                    <button 
                      onClick={() => {
                        deleteItem(currentItem.id);
                        setCurrentView({ type: 'root' });
                      }}
                      className="p-2 text-slate-400 hover:text-red-500 transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsBirdsEye(!isBirdsEye)}
                className={cn(
                  "px-4 py-2 rounded-xl font-bold text-sm transition-all flex items-center gap-2",
                  isBirdsEye 
                    ? "bg-indigo-600 text-white shadow-lg shadow-indigo-200 dark:shadow-none" 
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-900 transition-colors"
                )}
              >
                <Eye className="w-4 h-4" />
                {isBirdsEye ? "Exit Bird's Eye" : "Bird's Eye View"}
              </button>

              {/* Visual Timer Button */}
              <div className="flex flex-col items-center gap-4">
                {isTimerActive ? (
                  !timerTaskId ? (
                    <div className="relative flex items-center justify-center group scale-125 md:scale-150">
                      <svg className="w-24 h-24 transform -rotate-90">
                        <circle
                          cx="48"
                          cy="48"
                          r="44"
                          stroke="currentColor"
                          strokeWidth="4"
                          fill="transparent"
                          className="text-slate-200 dark:text-slate-800"
                        />
                        <motion.circle
                          cx="48"
                          cy="48"
                          r="44"
                          stroke="currentColor"
                          strokeWidth="4"
                          fill="transparent"
                          strokeDasharray={276.46}
                          initial={{ strokeDashoffset: 0 }}
                          animate={{ strokeDashoffset: 276.46 * (1 - timeLeft / timerDuration) }}
                          transition={{ duration: 1, ease: "linear" }}
                          className="text-indigo-600 dark:text-indigo-400"
                        />
                      </svg>
                      <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <span className="font-mono font-black text-2xl text-slate-900 dark:text-white leading-none">
                          {formatTime(timeLeft)}
                        </span>
                        <button 
                          onClick={() => { 
                            setIsTimerActive(false); 
                            setTimeLeft(0); 
                            setTimerEndTime(null);
                          }}
                          className="mt-1 p-1 text-slate-400 hover:text-red-500 transition-colors"
                        >
                          <Plus className="w-4 h-4 rotate-45" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex items-center gap-4 px-6 py-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800 rounded-2xl"
                    >
                      <div className="flex flex-col">
                        <span className="text-[10px] font-black text-emerald-600 dark:text-emerald-400 uppercase tracking-widest">Focusing On</span>
                        <span className="text-sm font-bold text-slate-900 dark:text-white truncate max-w-[150px]">
                          {items.find(i => i.id === timerTaskId)?.title || 'Task'}
                        </span>
                      </div>
                      <div className="h-8 w-[1px] bg-emerald-200 dark:bg-emerald-800" />
                      <div className="flex items-center gap-3">
                        <span className="font-mono font-black text-xl text-emerald-600 dark:text-emerald-400">
                          {formatTime(timeLeft)}
                        </span>
                        <button 
                          onClick={() => { 
                            setIsTimerActive(false); 
                            setTimeLeft(0); 
                            setTimerEndTime(null);
                          }}
                          className="p-2 bg-white dark:bg-slate-800 rounded-full text-slate-400 hover:text-red-500 shadow-sm transition-colors"
                        >
                          <Plus className="w-4 h-4 rotate-45" />
                        </button>
                      </div>
                    </motion.div>
                  )
                ) : (
                  <div className="flex flex-col items-center gap-4">
                    <div className="flex items-center gap-4">
                      <div className="relative">
                        <button
                          onClick={startTimer}
                          className="flex flex-col items-center justify-center w-24 h-24 bg-white dark:bg-slate-900 border-4 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 rounded-full font-bold hover:border-indigo-600 dark:hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-all shadow-md active:scale-95 group"
                        >
                          <Clock className="w-8 h-8 mb-1 group-hover:scale-110 transition-transform" />
                          <span className="text-xs uppercase tracking-tighter">Start</span>
                        </button>
                        <button 
                          onClick={() => setIsEditingTimer(!isEditingTimer)}
                          className="absolute -top-1 -right-1 p-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-full shadow-sm hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                        >
                          <Edit3 className="w-3 h-3" />
                        </button>
                      </div>
                      <button 
                        onClick={() => setIsHistoryOpen(true)}
                        className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl text-slate-400 dark:text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 transition-all shadow-sm"
                        title="Timer History"
                      >
                        <Clock className="w-6 h-6" />
                      </button>
                    </div>
                    {isEditingTimer && (
                      <div className="flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
                        <input 
                          type="number" 
                          value={timerDuration / 60}
                          onChange={(e) => setTimerDuration(Math.max(1, parseInt(e.target.value) || 1) * 60)}
                          className="w-16 p-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-center font-bold text-sm dark:text-white"
                        />
                        <span className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">min</span>
                      </div>
                    )}
                    <div className="w-full max-w-[200px] space-y-1">
                      <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest px-1">Focus Task (Optional)</label>
                      <select 
                        value={timerTaskId}
                        onChange={(e) => setTimerTaskId(e.target.value)}
                        className="w-full p-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-bold focus:ring-2 focus:ring-indigo-500 dark:text-white"
                      >
                        <option value="">General Focus</option>
                        {items.filter(i => i.type === 'task' && !i.completed).map(task => (
                          <option key={task.id} value={task.id}>{task.title}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {currentView.type === 'calendar' ? (
            <section className="space-y-8">
              {/* Calendar Tabs */}
              <div className="flex items-center gap-4">
                <div className="flex gap-2 p-1 bg-slate-100 dark:bg-slate-800 rounded-2xl w-fit">
                  {(['daily', 'weekly', 'monthly', 'yearly'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => {
                        setCalendarTab(tab);
                        setIsArchiveOpen(false);
                      }}
                      className={cn(
                        "px-6 py-2 rounded-xl text-sm font-bold transition-all capitalize",
                        calendarTab === tab && !isArchiveOpen
                          ? "bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-sm" 
                          : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                      )}
                    >
                      {tab}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setIsArchiveOpen(!isArchiveOpen)}
                  className={cn(
                    "p-2 rounded-xl transition-all",
                    isArchiveOpen 
                      ? "bg-indigo-600 text-white shadow-md" 
                      : "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400"
                  )}
                  title="View Activity Log"
                >
                  <Archive className="w-5 h-5" />
                </button>
              </div>

              {isArchiveOpen ? (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-2xl font-black text-slate-900 dark:text-white capitalize">{calendarTab} Activity Log</h2>
                    <div className="text-xs font-bold text-slate-400 uppercase tracking-widest">
                      {archiveItems.length} Items Found
                    </div>
                  </div>
                  
                  <div className="grid gap-4">
                    {archiveItems.map(item => (
                      <div 
                        key={`archive-${item.id}`}
                        className="p-6 bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between group hover:border-indigo-200 dark:hover:border-indigo-900 transition-all"
                      >
                        <div className="flex items-center gap-4">
                          <div className={cn(
                            "w-10 h-10 rounded-2xl flex items-center justify-center",
                            (item.completed || (item.type === 'habit' && item.habit_logs?.some(l => l.timestamp && (l.value === true || (typeof l.value === 'number' && l.value > 0))))) 
                              ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600" 
                              : "bg-slate-100 dark:bg-slate-800 text-slate-400"
                          )}>
                            {(item.completed || (item.type === 'habit' && item.habit_logs?.some(l => l.timestamp && (l.value === true || (typeof l.value === 'number' && l.value > 0))))) 
                              ? <CheckCircle2 className="w-5 h-5" /> 
                              : <Clock className="w-5 h-5" />}
                          </div>
                          <div>
                            <h3 className={cn("font-bold text-slate-900 dark:text-white", item.completed && "line-through opacity-50")}>
                              {item.title}
                            </h3>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                {item.type}
                              </span>
                              {(() => {
                                const completionTime = item.completedAt || (item.type === 'habit' && item.habit_logs?.filter(l => l.timestamp && (l.value === true || (typeof l.value === 'number' && l.value > 0))).sort((a, b) => new Date(b.timestamp!).getTime() - new Date(a.timestamp!).getTime())[0]?.timestamp);
                                if (completionTime) {
                                  return (
                                    <>
                                      <span className="text-slate-300 dark:text-slate-700">•</span>
                                      <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                                        Done at {new Date(completionTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                      </span>
                                    </>
                                  );
                                }
                                return null;
                              })()}
                            </div>
                          </div>
                        </div>
                        
                        <div className="text-right">
                          <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                            {item.deadline ? 'Deadline' : 'Created'}
                          </div>
                          <div className="text-xs font-bold text-slate-600 dark:text-slate-400">
                            {new Date(item.deadline || item.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                          </div>
                        </div>
                      </div>
                    ))}
                    
                    {archiveItems.length === 0 && (
                      <div className="text-center py-20 bg-slate-50/50 dark:bg-slate-900/50 rounded-3xl border border-dashed border-slate-200 dark:border-slate-800">
                        <Archive className="w-12 h-12 text-slate-300 dark:text-slate-700 mx-auto mb-4" />
                        <p className="text-slate-400 font-medium italic">No activity found for this period.</p>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  {/* Progress Timer */}
                  <div className="bg-white dark:bg-slate-900 rounded-3xl p-8 border border-slate-200 dark:border-slate-800 shadow-sm">
                    <div className="flex flex-col md:flex-row items-center gap-8">
                      <div className="relative w-48 h-48 flex items-center justify-center">
                        <svg className="w-full h-full transform -rotate-90">
                          <circle
                            cx="96"
                            cy="96"
                            r="88"
                            stroke="currentColor"
                            strokeWidth="12"
                            fill="transparent"
                            className="text-slate-100 dark:text-slate-800"
                          />
                          <motion.circle
                            cx="96"
                            cy="96"
                            r="88"
                            stroke="currentColor"
                            strokeWidth="12"
                            fill="transparent"
                            strokeDasharray={552.92}
                            initial={{ strokeDashoffset: 552.92 }}
                            animate={{ strokeDashoffset: 552.92 * (1 - timeProgress[calendarTab] / 100) }}
                            transition={{ duration: 1.5, ease: "easeOut" }}
                            className={cn(
                              calendarTab === 'daily' && "text-rose-500",
                              calendarTab === 'weekly' && "text-amber-500",
                              calendarTab === 'monthly' && "text-emerald-500",
                              calendarTab === 'yearly' && "text-indigo-500"
                            )}
                          />
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                          <span className="text-3xl font-black text-slate-900 dark:text-white">
                            {Math.round(timeProgress[calendarTab])}%
                          </span>
                          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Elapsed</span>
                        </div>
                      </div>
                      <div className="flex-1 space-y-4 text-center md:text-left">
                        <div>
                          <h2 className="text-2xl font-black text-slate-900 dark:text-white capitalize">{calendarTab} Progress</h2>
                          <p className="text-slate-500 dark:text-slate-400 font-medium">
                            {calendarTab === 'daily' && `${timeProgress.timeLeft.daily.toFixed(1)} hours left in the day`}
                            {calendarTab === 'weekly' && `${timeProgress.timeLeft.weekly.toFixed(1)} days left in the week`}
                            {calendarTab === 'monthly' && `${timeProgress.timeLeft.monthly.toFixed(1)} days left in the month`}
                            {calendarTab === 'yearly' && `${timeProgress.timeLeft.yearly.toFixed(0)} days left in the year`}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-3 justify-center md:justify-start">
                          <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800 rounded-xl border border-slate-100 dark:border-slate-700">
                            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Current Date</div>
                            <div className="text-sm font-bold dark:text-white">{new Date().toLocaleDateString(undefined, { dateStyle: 'long' })}</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* View Content */}
                  <div className="space-y-6">
                    {calendarTab === 'daily' && <PeriodChecklist title="Today's Checklist" placeholder="Add a task for today..." deadline={periodDeadlines.daily} scope="daily" filterFn={periodFilters.daily} />}

                    {calendarTab === 'weekly' && (
                      <div className="space-y-8">
                        <PeriodChecklist title="This Week's Checklist" placeholder="Add a task for this week..." deadline={periodDeadlines.weekly} scope="weekly" filterFn={periodFilters.weekly} />
                        
                        <div className="grid grid-cols-1 md:grid-cols-7 gap-4">
                        {Array.from({ length: 7 }).map((_, idx) => {
                          const date = new Date();
                          const offset = (date.getDay() - 5 + 7) % 7;
                          date.setDate(date.getDate() - offset + idx);
                          const isToday = date.toDateString() === new Date().toDateString();
                          const dayItems = items
                            .filter(i => {
                              const allowedScopes = ['daily', 'weekly', 'monthly', 'yearly'];
                              const isMeta = !i.scope || allowedScopes.includes(i.scope);
                              return isMeta && i.deadline && new Date(i.deadline).toDateString() === date.toDateString();
                            })
                            .sort((a, b) => {
                              if (a.completed === b.completed) return 0;
                              return a.completed ? 1 : -1;
                            });

                          return (
                            <div key={`week-day-${idx}`} className={cn(
                              "flex flex-col rounded-2xl border p-3 min-h-[120px] transition-all",
                              isToday ? "bg-indigo-50/50 dark:bg-indigo-900/10 border-indigo-200 dark:border-indigo-800" : "bg-white dark:bg-slate-900 border-slate-100 dark:border-slate-800"
                            )}>
                              <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">
                                {date.toLocaleDateString(undefined, { weekday: 'short' })} {date.getDate()}
                              </div>
                              <div className="flex-1 space-y-1">
                                {dayItems.slice(0, 3).map(item => (
                                  <div key={`week-item-${item.id}`} className="text-[10px] font-bold truncate bg-slate-100 dark:bg-slate-800 p-1 rounded-md flex items-center gap-1">
                                    <button 
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleComplete(item);
                                      }}
                                      className={cn("w-2 h-2 rounded-full border border-slate-400", item.completed && "bg-indigo-500 border-indigo-500")}
                                    />
                                    <span className={cn(item.completed && "line-through opacity-50")}>{item.title}</span>
                                  </div>
                                ))}
                                {dayItems.length > 3 && (
                                  <div className="text-[8px] font-black text-slate-400 text-center">+{dayItems.length - 3} more</div>
                                )}
                              </div>
                              <input 
                                type="text"
                                placeholder="+"
                                className="mt-2 w-full bg-transparent border-none text-[10px] font-bold focus:ring-0 outline-none placeholder:text-slate-300 dark:placeholder:text-slate-700 dark:text-white"
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    const val = (e.target as HTMLInputElement).value;
                                    if (val.trim()) {
                                      quickAddTask(val, date.toISOString().split('T')[0], 'daily');
                                      (e.target as HTMLInputElement).value = '';
                                    }
                                  }
                                }}
                              />
                            </div>
                          );
                        })}
                        </div>
                      </div>
                    )}

                    {calendarTab === 'monthly' && (
                      <div className="space-y-8">
                        <PeriodChecklist title="This Month's Checklist" placeholder="Add a task for this month..." deadline={periodDeadlines.monthly} scope="monthly" filterFn={periodFilters.monthly} />
                        
                        <div className="grid grid-cols-7 gap-2">
                        {Array.from({ length: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate() }).map((_, idx) => {
                          const date = new Date(new Date().getFullYear(), new Date().getMonth(), idx + 1);
                          const isToday = date.toDateString() === new Date().toDateString();
                          const dayItems = items
                            .filter(i => {
                              const allowedScopes = ['daily', 'weekly', 'monthly', 'yearly'];
                              const isMeta = !i.scope || allowedScopes.includes(i.scope);
                              return isMeta && i.deadline && new Date(i.deadline).toDateString() === date.toDateString();
                            })
                            .sort((a, b) => {
                              if (a.completed === b.completed) return 0;
                              return a.completed ? 1 : -1;
                            });

                          return (
                            <div key={`month-day-${idx}`} className={cn(
                              "min-h-[100px] rounded-xl border p-2 flex flex-col relative transition-all group",
                              isToday ? "bg-indigo-50/50 dark:bg-indigo-900/10 border-indigo-200 dark:border-indigo-800" : "bg-white dark:bg-slate-900 border-slate-100 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:border-indigo-300"
                            )}>
                              <div className="flex justify-between items-start mb-1">
                                <span className={cn("text-xs font-black", isToday && "text-indigo-600 dark:text-indigo-400")}>{idx + 1}</span>
                              </div>
                              <div className="flex-1 space-y-0.5 overflow-hidden">
                                {dayItems.slice(0, 2).map(item => (
                                  <div key={`month-item-${item.id}`} className="text-[8px] font-bold truncate bg-slate-100 dark:bg-slate-800 p-0.5 rounded flex items-center gap-1">
                                    <button 
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleComplete(item);
                                      }}
                                      className={cn("w-1.5 h-1.5 rounded-full border border-slate-400", item.completed && "bg-indigo-500 border-indigo-500")}
                                    />
                                    <span className={cn(item.completed && "line-through opacity-50")}>{item.title}</span>
                                  </div>
                                ))}
                                {dayItems.length > 2 && (
                                  <div className="text-[7px] font-black text-slate-400 text-center">+{dayItems.length - 2}</div>
                                )}
                              </div>
                              <input 
                                type="text"
                                placeholder="+"
                                className="mt-1 w-full bg-transparent border-none text-[8px] font-bold focus:ring-0 outline-none placeholder:text-slate-300 dark:placeholder:text-slate-700 dark:text-white"
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    const val = (e.target as HTMLInputElement).value;
                                    if (val.trim()) {
                                      quickAddTask(val, date.toISOString().split('T')[0], 'daily');
                                      (e.target as HTMLInputElement).value = '';
                                    }
                                  }
                                }}
                              />
                            </div>
                          );
                        })}
                        </div>
                      </div>
                    )}

                    {calendarTab === 'yearly' && (
                      <div className="space-y-8">
                        <PeriodChecklist title="This Year's Checklist" placeholder="Add a task for this year..." deadline={periodDeadlines.yearly} scope="yearly" filterFn={periodFilters.yearly} />
                        
                        <div className="grid grid-cols-3 md:grid-cols-4 gap-4">
                        {Array.from({ length: 12 }).map((_, idx) => {
                          const date = new Date(new Date().getFullYear(), idx, 1);
                          const isCurrentMonth = idx === new Date().getMonth();
                          
                          return (
                            <div key={`year-month-${idx}`} className={cn(
                              "p-4 rounded-2xl border transition-all group relative",
                              isCurrentMonth ? "bg-indigo-50/50 dark:bg-indigo-900/10 border-indigo-200 dark:border-indigo-800" : "bg-white dark:bg-slate-900 border-slate-100 dark:border-slate-800"
                            )}>
                              <div className="flex justify-between items-start mb-2">
                                <div className="text-xs font-black text-slate-900 dark:text-white uppercase tracking-widest">
                                  {date.toLocaleDateString(undefined, { month: 'short' })}
                                </div>
                              </div>
                              <div className="space-y-1 mb-3">
                                {items
                                  .filter(i => {
                                    const allowedScopes = ['daily', 'weekly', 'monthly', 'yearly'];
                                    const isMeta = !i.scope || allowedScopes.includes(i.scope);
                                    if (!isMeta || !i.deadline) return false;
                                    const d = new Date(i.deadline);
                                    return d.getMonth() === idx && d.getFullYear() === new Date().getFullYear();
                                  })
                                  .sort((a, b) => {
                                    if (a.completed === b.completed) return 0;
                                    return a.completed ? 1 : -1;
                                  })
                                  .slice(0, 3)
                                  .map(item => (
                                    <div key={`year-item-${item.id}`} className="text-[8px] font-bold truncate bg-slate-100 dark:bg-slate-800 p-0.5 rounded flex items-center gap-1">
                                      <button 
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          toggleComplete(item);
                                        }}
                                        className={cn("w-1.5 h-1.5 rounded-full border border-slate-400", item.completed && "bg-indigo-500 border-indigo-500")}
                                      />
                                      <span className={cn(item.completed && "line-through opacity-50")}>{item.title}</span>
                                    </div>
                                  ))}
                              </div>
                              <div className="grid grid-cols-7 gap-0.5 mb-2">
                                {Array.from({ length: new Date(new Date().getFullYear(), idx + 1, 0).getDate() }).map((_, dIdx) => (
                                  <div key={`year-m-${idx}-d-${dIdx}`} className="w-1 h-1 bg-slate-200 dark:bg-slate-700 rounded-full" />
                                ))}
                              </div>
                              <input 
                                type="text"
                                placeholder="+"
                                className="w-full bg-transparent border-none text-[8px] font-bold focus:ring-0 outline-none placeholder:text-slate-300 dark:placeholder:text-slate-700 dark:text-white"
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    const val = (e.target as HTMLInputElement).value;
                                    if (val.trim()) {
                                      // For yearly month cells, we set the deadline to the 1st of that month
                                      quickAddTask(val, date.toISOString().split('T')[0], 'monthly');
                                      (e.target as HTMLInputElement).value = '';
                                    }
                                  }
                                }}
                              />
                            </div>
                          );
                        })}
                        </div>
                      </div>
                    )}
                    
                    {renderHabitsProgress()}
                  </div>
                </>
              )}
            </section>
          ) : isBirdsEye ? (
            <section className="space-y-8">
              <div className="flex items-center justify-end">
                <div className="text-slate-400 dark:text-slate-500 font-bold">{items.length} Total Items</div>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {lifeAreas.map(area => (
                  <div key={area.id} className={cn(
                    "space-y-4 p-6 rounded-3xl border shadow-sm transition-colors duration-300",
                    area.priority ? getPriorityClasses(area.priority) : "bg-white dark:bg-slate-900 border-slate-100 dark:border-slate-800"
                  )}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-indigo-50 dark:bg-indigo-900/20 rounded-xl flex items-center justify-center text-indigo-600 dark:text-indigo-400">
                          <Brain className="w-5 h-5" />
                        </div>
                        <h3 className="text-xl font-black text-slate-900 dark:text-white">{area.title}</h3>
                      </div>
                      <div className="flex items-center gap-1">
                        <button 
                          onClick={() => {
                            setSelectedItem(area);
                            setIsEditing(true);
                            setEditForm(area);
                          }}
                          className="p-2 text-slate-400 hover:text-indigo-600 transition-colors"
                          title="Edit Area"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => deleteItem(area.id)}
                          className="p-2 text-slate-400 hover:text-red-500 transition-colors"
                          title="Delete Area"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    
                    <div className="space-y-6 pl-4 border-l-2 border-slate-50 dark:border-slate-800">
                      {/* Projects in this area */}
                      {(itemsByParent[area.id] || []).filter(i => i.type === 'project').map(project => (
                        <div key={project.id} className="space-y-2">
                          <h4 className="text-sm font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest flex items-center gap-2">
                            <Layers className="w-3 h-3" />
                            {project.title}
                          </h4>
                          <div className="grid gap-2 pl-4">
                            {(itemsByParent[project.id] || []).map(child => (
                              <div key={child.id} className={cn(
                                "space-y-1 p-2 rounded-xl transition-all",
                                child.priority ? getPriorityClasses(child.priority) : ""
                              )}>
                                <div className="flex items-center gap-2 text-sm font-bold text-slate-600 dark:text-slate-300">
                                  <div className={cn(
                                    "w-2 h-2 rounded-full",
                                    child.type === 'task' ? "bg-indigo-400" : (child.type === 'habit' ? "bg-orange-400" : (child.type === 'note' ? "bg-slate-400" : "bg-slate-300"))
                                  )} />
                                  {child.title}
                                </div>
                                {child.deadline && !child.completed && (
                                  <div className="pl-4">
                                    <div className="w-24 h-1 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                                      <div 
                                        className={cn(
                                          "h-full rounded-full",
                                          calculateDeadlineProgress(child.createdAt, child.deadline)?.status === 'critical' ? "bg-red-500" : "bg-indigo-500"
                                        )}
                                        style={{ width: `${calculateDeadlineProgress(child.createdAt, child.deadline)?.percentage || 0}%` }}
                                      />
                                    </div>
                                  </div>
                                )}
                                {/* Show children of tasks (like notes) */}
                                {child.type === 'task' && (itemsByParent[child.id] || []).map(grandChild => (
                                  <div key={grandChild.id} className="flex items-center gap-2 text-[10px] font-bold text-slate-400 dark:text-slate-500 pl-4">
                                    <div className="w-1.5 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700" />
                                    {grandChild.title}
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                      
                      {/* Direct children (habits/tasks/notes) in this area */}
                      {(itemsByParent[area.id] || []).filter(i => i.type !== 'project').map(child => (
                        <div key={child.id} className={cn(
                          "space-y-1 p-2 rounded-xl transition-all",
                          child.priority ? getPriorityClasses(child.priority) : ""
                        )}>
                          <div className="flex items-center gap-2 text-sm font-bold text-slate-600 dark:text-slate-300">
                            <div className={cn(
                              "w-2 h-2 rounded-full",
                              child.type === 'task' ? "bg-indigo-400" : (child.type === 'habit' ? "bg-orange-400" : (child.type === 'note' ? "bg-slate-400" : "bg-slate-300"))
                            )} />
                            {child.title}
                          </div>
                          {child.deadline && !child.completed && (
                            <div className="pl-4">
                              <div className="w-24 h-1 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                                <div 
                                  className={cn(
                                    "h-full rounded-full",
                                    calculateDeadlineProgress(child.createdAt, child.deadline)?.status === 'critical' ? "bg-red-500" : "bg-indigo-500"
                                  )}
                                  style={{ width: `${calculateDeadlineProgress(child.createdAt, child.deadline)?.percentage || 0}%` }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                
                {/* Uncategorized */}
                {(itemsByParent['root'] || []).filter(i => i.type !== 'life_area').length > 0 && (
                  <div className="space-y-4 p-6 bg-slate-50 dark:bg-slate-800/50 rounded-3xl border border-dashed border-slate-200 dark:border-slate-700">
                    <h3 className="text-xl font-black text-slate-400 dark:text-slate-500">Uncategorized</h3>
                    <div className="grid gap-2">
                      {(itemsByParent['root'] || []).filter(i => i.type !== 'life_area').map(item => (
                        <div key={item.id} className={cn(
                          "space-y-1 p-2 rounded-xl transition-all",
                          item.priority ? getPriorityClasses(item.priority) : ""
                        )}>
                          <div className="flex items-center gap-2 text-sm font-bold text-slate-600 dark:text-slate-300">
                            <div className={cn(
                              "w-2 h-2 rounded-full",
                              item.type === 'task' ? "bg-indigo-400" : (item.type === 'habit' ? "bg-orange-400" : (item.type === 'note' ? "bg-slate-400" : "bg-slate-300"))
                            )} />
                            {item.title}
                          </div>
                          {item.deadline && !item.completed && (
                            <div className="pl-4">
                              <div className="w-24 h-1 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                                <div 
                                  className={cn(
                                    "h-full rounded-full",
                                    calculateDeadlineProgress(item.createdAt, item.deadline)?.status === 'critical' ? "bg-red-500" : "bg-indigo-500"
                                  )}
                                  style={{ width: `${calculateDeadlineProgress(item.createdAt, item.deadline)?.percentage || 0}%` }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          ) : (
            <>
              {/* Brain Dump Section */}
          <section className="space-y-4">
            <div className="bg-white dark:bg-slate-900 rounded-3xl p-6 shadow-sm border border-slate-200 dark:border-slate-800 space-y-4 transition-colors duration-300">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400">
                  <Zap className="w-5 h-5 fill-current" />
                  <h2 className="font-bold text-lg dark:text-white">{isManualMode ? "Manual Entry" : "Emergency Brain Dump"}</h2>
                </div>
                <button 
                  onClick={() => setIsManualMode(!isManualMode)}
                  className="text-xs font-bold text-slate-400 dark:text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 uppercase tracking-widest transition-colors"
                >
                  Switch to {isManualMode ? "AI Mode" : "Manual Mode"}
                </button>
              </div>

              {isManualMode && (
                <div className="space-y-4">
                  <div className="flex gap-2 p-1 bg-slate-100 dark:bg-slate-800 rounded-full overflow-x-auto">
                    {(['task', 'project', 'life_area', 'note', 'habit'] as ItemType[]).map(t => (
                      <button
                        key={t}
                        onClick={() => {
                          setManualType(t);
                          setManualParentId(currentView.id || '');
                        }}
                        className={cn(
                          "flex-1 py-2 px-4 text-xs font-bold rounded-full transition-all whitespace-nowrap",
                          manualType === t ? "bg-[#2B4189] text-white shadow-md" : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                        )}
                      >
                        {t.replace('_', ' ').toUpperCase()}
                      </button>
                    ))}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="relative">
                      <select
                        value={manualParentId}
                        onChange={(e) => setManualParentId(e.target.value)}
                        className="w-full p-3 bg-slate-50 dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 text-sm font-bold focus:ring-2 focus:ring-indigo-500 dark:text-white appearance-none"
                      >
                        <option value="">Belongs to Project/Area/Task</option>
                        {projects.map(p => <option key={`project-opt-${p.id}`} value={p.id}>{p.title} (Project)</option>)}
                        {lifeAreas.map(a => <option key={`area-opt-${a.id}`} value={a.id}>{a.title} (Area)</option>)}
                        {manualType === 'note' && items.filter(i => i.type === 'task').map(t => (
                          <option key={`task-opt-${t.id}`} value={t.id}>{t.title} (Task)</option>
                        ))}
                      </select>
                      <ChevronRight className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 rotate-90" />
                    </div>
                    <div className="relative">
                      <input 
                        type="date"
                        value={manualDeadline}
                        onChange={(e) => setManualDeadline(e.target.value)}
                        className="w-full p-3 bg-slate-50 dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 text-sm font-bold focus:ring-2 focus:ring-indigo-500 dark:text-white"
                      />
                      <div className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center gap-2 pointer-events-none bg-slate-50 dark:bg-slate-800 pr-2">
                        <Clock className="w-4 h-4 text-slate-400" />
                        <span className="text-slate-400">Deadline (Optional)</span>
                      </div>
                    </div>
                    {(manualType === 'task' || manualType === 'habit') && (
                      <div className="relative">
                        <select
                          value={manualRecurrence}
                          onChange={(e) => setManualRecurrence(e.target.value as any)}
                          className="w-full p-3 bg-slate-50 dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 text-sm font-bold focus:ring-2 focus:ring-indigo-500 dark:text-white appearance-none"
                        >
                          <option value="none">No Recurrence</option>
                          <option value="daily">Daily</option>
                          <option value="weekly">Weekly</option>
                          <option value="monthly">Monthly</option>
                          <option value="yearly">Yearly</option>
                        </select>
                        <ChevronRight className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 rotate-90" />
                      </div>
                    )}
                    <div className="relative">
                      <select
                        value={manualPriority}
                        onChange={(e) => setManualPriority(e.target.value as any)}
                        className="w-full p-3 bg-slate-50 dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 text-sm font-bold focus:ring-2 focus:ring-indigo-500 dark:text-white appearance-none"
                      >
                        <option value="">Priority (Optional)</option>
                        <option value="low">Low Priority</option>
                        <option value="moderate">Moderate Priority</option>
                        <option value="high">High Priority</option>
                      </select>
                      <ChevronRight className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 rotate-90" />
                    </div>
                  </div>
                </div>
              )}

              <textarea
                value={brainDump}
                onChange={(e) => setBrainDump(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && brainDump.trim()) {
                    e.preventDefault();
                    handleSubmitDump();
                  }
                }}
                placeholder="Write your item here..."
                className="w-full min-h-[120px] p-4 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 focus:ring-2 focus:ring-indigo-500 text-lg resize-none placeholder:text-slate-400 dark:text-white dark:placeholder:text-slate-500"
              />
              
              <button
                onClick={handleSubmitDump}
                disabled={isProcessing || !brainDump.trim()}
                className={cn(
                  "w-full py-4 rounded-2xl font-bold text-lg flex items-center justify-center gap-2 transition-all active:scale-95",
                  isProcessing 
                    ? "bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed" 
                    : "bg-[#2B4189] text-white hover:bg-[#1E2E63] shadow-lg"
                )}
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <Plus className="w-5 h-5" />
                    Add Item
                  </>
                )}
              </button>
            </div>
          </section>

          {/* Item Type Filter */}
          <section className="space-y-4">
            <div className="flex items-center justify-center">
              <h2 className="font-bold text-xl text-slate-800 dark:text-white">
                What are you looking for?
              </h2>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-4xl mx-auto">
              <button
                onClick={() => setTypeFilter('all')}
                className={cn(
                  "px-6 py-3 rounded-full font-bold transition-all text-sm",
                  typeFilter === 'all' 
                    ? "bg-[#2B4189] text-white shadow-lg scale-105" 
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:bg-slate-50"
                )}
              >
                All Items
              </button>
              <button
                onClick={() => setTypeFilter('task')}
                className={cn(
                  "px-6 py-3 rounded-full font-bold transition-all text-sm",
                  typeFilter === 'task' 
                    ? "bg-indigo-600 text-white shadow-lg scale-105" 
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:bg-slate-50"
                )}
              >
                Tasks
              </button>
              <button
                onClick={() => setTypeFilter('project')}
                className={cn(
                  "px-6 py-3 rounded-full font-bold transition-all text-sm",
                  typeFilter === 'project' 
                    ? "bg-amber-500 text-white shadow-lg scale-105" 
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:bg-slate-50"
                )}
              >
                Projects
              </button>
              <button
                onClick={() => setTypeFilter('habit')}
                className={cn(
                  "px-6 py-3 rounded-full font-bold transition-all text-sm",
                  typeFilter === 'habit' 
                    ? "bg-emerald-600 text-white shadow-lg scale-105" 
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:bg-slate-50"
                )}
              >
                Habits
              </button>
            </div>
          </section>

          {/* Items List */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-xl dark:text-white">
                {currentItem ? `Items in ${currentItem.title}` : "Actionable Data"}
              </h2>
              <span className="text-slate-400 dark:text-slate-500 text-sm font-medium">{visibleItems.length} items</span>
            </div>
            
            <Reorder.Group axis="y" values={visibleItems} onReorder={handleReorder} className="grid gap-4">
              <AnimatePresence mode="popLayout">
                {visibleItems.map((item) => (
                  <Reorder.Item
                    key={item.id}
                    value={item}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className={cn(
                      "group rounded-3xl p-5 shadow-sm border transition-all cursor-pointer transition-colors duration-300",
                      item.type === 'note' 
                        ? "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 hover:border-amber-300 dark:hover:border-amber-700" 
                        : (item.priority ? getPriorityClasses(item.priority) : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-indigo-200 dark:hover:border-indigo-900"),
                      item.completed && "opacity-60 grayscale"
                    )}
                    onClick={() => {
                      if (item.type === 'life_area') {
                        setCurrentView({ type: 'area', id: item.id });
                      } else if (item.type === 'project') {
                        setCurrentView({ type: 'project', id: item.id });
                      } else {
                        setSelectedItem(item);
                      }
                    }}
                  >
                    <div className="flex items-center gap-4">
                      <div className="cursor-grab active:cursor-grabbing text-slate-300 dark:text-slate-700 hover:text-slate-400 transition-colors">
                        <GripVertical className="w-5 h-5" />
                      </div>
                      <div className={cn(
                        "w-12 h-12 rounded-2xl flex items-center justify-center shadow-sm border transition-colors",
                        item.type === 'note' 
                          ? "bg-amber-100 dark:bg-amber-800 border-amber-200 dark:border-amber-700" 
                          : "bg-white dark:bg-slate-800 border-slate-100 dark:border-slate-700"
                      )}>
                        {item.type === 'task' && <Zap className="w-6 h-6 text-amber-400 fill-current" />}
                        {item.type === 'project' && <Target className="w-6 h-6 text-indigo-500" />}
                        {item.type === 'habit' && <Layers className="w-6 h-6 text-emerald-500" />}
                        {item.type === 'life_area' && <Folder className="w-6 h-6 text-indigo-400" />}
                        {item.type === 'note' && <StickyNote className="w-6 h-6 text-amber-600" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className={cn("text-lg font-bold text-slate-900 dark:text-white truncate", item.completed && "line-through opacity-50")}>
                            {item.title}
                          </h3>
                          {isTimerActive && timerTaskId === item.id && (
                            <div className="flex items-center gap-2 px-2 py-0.5 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-full animate-pulse">
                              <Clock className="w-3 h-3" />
                              <span className="text-[10px] font-black font-mono">{formatTime(timeLeft)}</span>
                              <button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setIsTimerActive(false);
                                  setTimeLeft(0);
                                  setTimerEndTime(null);
                                }}
                                className="hover:text-red-500 transition-colors"
                              >
                                <Plus className="w-3 h-3 rotate-45" />
                              </button>
                            </div>
                          )}
                          {item.recurrence && item.recurrence !== 'none' && (
                            <div className="flex items-center gap-1 px-2 py-0.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded-full">
                              <Repeat className="w-3 h-3" />
                              <span className="text-[10px] font-black uppercase tracking-widest">{item.recurrence}</span>
                            </div>
                          )}
                          {item.time_budget && (
                            <div className="flex items-center gap-1 px-2 py-0.5 bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 rounded-full">
                              <Hourglass className="w-3 h-3" />
                              <span className="text-[10px] font-black uppercase tracking-widest">Budget</span>
                            </div>
                          )}
                        </div>

                        {item.deadline && !item.completed && (
                          (() => {
                            const progress = calculateDeadlineProgress(item.createdAt, item.deadline);
                            if (!progress) return null;
                            return (
                              <div className="mt-2 space-y-1">
                                <div className="flex justify-between items-center text-[10px] font-black uppercase tracking-wider">
                                  <span className={cn(
                                    progress.status === 'critical' ? "text-red-500" : progress.status === 'warning' ? "text-amber-500" : "text-slate-400"
                                  )}>
                                    {progress.remainingText}
                                  </span>
                                  <span className="text-slate-400">{Math.round(progress.percentage)}%</span>
                                </div>
                                <div className="h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                                  <motion.div 
                                    initial={{ width: 0 }}
                                    animate={{ width: `${progress.percentage}%` }}
                                    className={cn(
                                      "h-full rounded-full transition-colors duration-500",
                                      progress.status === 'critical' ? "bg-red-500" : progress.status === 'warning' ? "bg-amber-500" : "bg-indigo-500"
                                    )}
                                  />
                                </div>
                              </div>
                            );
                          })()
                        )}

                        {item.time_budget && !item.completed && (
                          <div className="mt-2 space-y-1">
                            <div className="flex justify-between items-center text-[10px] font-black uppercase tracking-wider">
                              <span className="text-slate-400">Time Budget</span>
                              {(() => {
                                const spent = timerHistory
                                  .filter(s => s.taskId === item.id)
                                  .reduce((acc, s) => acc + (s.durationSeconds || 0), 0);
                                return (
                                  <span className={spent > item.time_budget ? "text-red-500" : "text-indigo-500"}>
                                    {Math.round((spent / item.time_budget) * 100)}%
                                  </span>
                                );
                              })()}
                            </div>
                            <div className="h-1 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                              {(() => {
                                const spent = timerHistory
                                  .filter(s => s.taskId === item.id)
                                  .reduce((acc, s) => acc + (s.durationSeconds || 0), 0);
                                const progress = Math.min((spent / item.time_budget) * 100, 100);
                                return (
                                  <div 
                                    className={cn("h-full rounded-full", spent > item.time_budget ? "bg-red-500" : "bg-indigo-500")}
                                    style={{ width: `${progress}%` }}
                                  />
                                );
                              })()}
                            </div>
                          </div>
                        )}

                        {item.type === 'note' && (
                          <p className="text-sm text-slate-500 dark:text-slate-400 line-clamp-2 italic">
                            {item.original_intent}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedItem(item);
                            setIsEditing(true);
                            setEditForm(item);
                          }}
                          className="p-2 text-slate-400 hover:text-indigo-600"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteItem(item.id);
                          }}
                          className="p-2 text-slate-400 hover:text-red-500"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {item.type === 'habit' && item.habit_config && (
                      <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800 space-y-4" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-between gap-4 flex-wrap">
                          <div className="flex items-center gap-3">
                            <div className="flex gap-1">
                              {getLast7Days().map((date) => {
                                const log = item.habit_logs?.find(l => l.date === date);
                                const isCompleted = item.habit_config?.type === 'boolean' 
                                  ? !!log?.value 
                                  : (Number(log?.value) || 0) >= (item.habit_config?.goal || 1);
                                const dayName = new Date(date).toLocaleDateString('en-US', { weekday: 'narrow' });
                                const isToday = date === new Date().toISOString().split('T')[0];

                                return (
                                  <button
                                    key={`${item.id}-habit-${date}`}
                                    onClick={() => {
                                      if (item.habit_config?.type === 'boolean') {
                                        logHabit(item, !log?.value, date);
                                      } else {
                                        // For numeric, clicking toggles between 0 and goal
                                        const currentVal = Number(log?.value) || 0;
                                        const goal = item.habit_config?.goal || 1;
                                        logHabit(item, currentVal >= goal ? 0 : goal, date);
                                      }
                                    }}
                                    className={cn(
                                      "w-8 h-8 rounded-full border-2 flex items-center justify-center text-[10px] font-bold transition-all relative",
                                      isCompleted 
                                        ? "bg-[#2B4189] border-[#2B4189] text-white" 
                                        : "bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-400",
                                      isToday && "ring-2 ring-indigo-400 ring-offset-2 dark:ring-offset-slate-900"
                                    )}
                                  >
                                    {isCompleted ? <CheckCircle2 className="w-4 h-4" /> : dayName}
                                    {item.habit_config?.type === 'numeric' && log?.value !== undefined && Number(log.value) > 0 && (
                                      <span className="absolute -top-2 -right-2 bg-indigo-500 text-white text-[8px] px-1 rounded-full border border-white dark:border-slate-900">
                                        {log.value}
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                            <div className="bg-[#F3E8D2] text-[#8B6E32] px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest">
                              Current Streak {(() => {
                                let streak = 0;
                                const allDays = [...(item.habit_logs || [])].sort((a, b) => b.date.localeCompare(a.date));
                                const today = new Date().toISOString().split('T')[0];
                                const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
                                const lastLog = allDays[0];
                                if (!lastLog || (lastLog.date !== today && lastLog.date !== yesterday)) return 0;
                                for (let i = 0; i < allDays.length; i++) {
                                  const log = allDays[i];
                                  const isComp = item.habit_config?.type === 'boolean' ? !!log.value : (Number(log.value) || 0) >= (item.habit_config?.goal || 1);
                                  if (isComp) streak++; else break;
                                }
                                return streak;
                              })()}
                            </div>
                          </div>

                          {item.habit_config.type === 'numeric' && (
                            <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800/50 p-1.5 rounded-xl border border-slate-100 dark:border-slate-800">
                              <input
                                type="number"
                                placeholder="Log..."
                                className="w-16 px-2 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none font-bold"
                                defaultValue={item.habit_logs?.find(l => l.date === new Date().toISOString().split('T')[0])?.value as number || ''}
                                onBlur={(e) => {
                                  const val = parseFloat(e.target.value);
                                  if (!isNaN(val)) {
                                    logHabit(item, val);
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    const val = parseFloat((e.target as HTMLInputElement).value);
                                    if (!isNaN(val)) {
                                      logHabit(item, val);
                                      (e.target as HTMLInputElement).blur();
                                    }
                                  }
                                }}
                              />
                              <span className="text-[10px] font-bold text-slate-400 uppercase pr-1">{item.habit_config.unit}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </Reorder.Item>
                ))}
              </AnimatePresence>
              
              {visibleItems.length === 0 && (
                <div className="text-center py-20 space-y-4">
                  <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto">
                    <Brain className="w-8 h-8 text-slate-300" />
                  </div>
                  <p className="text-slate-400 font-medium">No items found here. Time to dump some brains!</p>
                </div>
              )}
            </Reorder.Group>
          </section>
        </>
      )}
    </main>
  </div>

      {/* Detail Modal */}
      <AnimatePresence>
        {isHistoryOpen && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                setIsHistoryOpen(false);
                setHistoryFilterId(null);
              }}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="relative w-full max-w-md bg-white dark:bg-slate-900 rounded-[32px] shadow-2xl overflow-hidden max-h-[80vh] flex flex-col"
            >
              <div className="p-8 space-y-6 overflow-y-auto">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <h2 className="text-2xl font-black dark:text-white">Timer History</h2>
                    {historyFilterId && (
                      <div className="text-xs font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-widest">
                        Filtered by: {items.find(i => i.id === historyFilterId)?.title || 'Item'}
                      </div>
                    )}
                  </div>
                  <button onClick={() => {
                    setIsHistoryOpen(false);
                    setHistoryFilterId(null);
                  }} className="p-2 bg-slate-100 dark:bg-slate-800 rounded-full transition-colors"><Plus className="w-6 h-6 rotate-45 dark:text-slate-400" /></button>
                </div>
                
                <div className="space-y-4">
                  {(() => {
                    const filtered = historyFilterId 
                      ? timerHistory.filter(s => s.taskId === historyFilterId)
                      : timerHistory;
                    
                    if (filtered.length === 0) {
                      return <div className="text-center py-10 text-slate-400 dark:text-slate-500">No sessions recorded yet.</div>;
                    }

                    return filtered.map(session => (
                      <div key={session.id} className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl space-y-1">
                        <div className="flex justify-between items-start">
                          <span className="font-bold text-slate-900 dark:text-white">{session.taskTitle}</span>
                          <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400">{Math.floor(session.durationSeconds / 60)}m</span>
                        </div>
                        <div className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest">
                          {new Date(session.completedAt).toLocaleString()}
                        </div>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {selectedItem && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                setSelectedItem(null);
                setIsEditing(false);
                setIsTimerSetupOpen(false);
                setIsHabitProgressOpen(false);
              }}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              className="relative w-full max-w-2xl bg-white dark:bg-slate-900 rounded-t-[32px] sm:rounded-[32px] shadow-2xl overflow-hidden max-h-[90vh] flex flex-col transition-colors duration-300"
            >
              <div className="p-6 sm:p-8 overflow-y-auto space-y-8">
                {isEditing ? (
                  <div className="space-y-6">
                    <div className="flex items-center justify-between">
                      <h2 className="text-2xl font-black dark:text-white">Edit Item</h2>
                      <button onClick={() => setIsEditing(false)} className="p-2 bg-slate-100 dark:bg-slate-800 rounded-full transition-colors"><Plus className="w-6 h-6 rotate-45 dark:text-slate-400" /></button>
                    </div>
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Title</label>
                        <input 
                          type="text" 
                          value={editForm.title || ''} 
                          onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                          className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-bold dark:text-white"
                        />
                      </div>
                      <div className="grid grid-cols-1 gap-4">
                        <div className="space-y-2">
                          <label className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Type</label>
                          <select 
                            value={editForm.type} 
                            onChange={(e) => setEditForm({ ...editForm, type: e.target.value as ItemType })}
                            className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-bold dark:text-white"
                          >
                            <option value="task">Task</option>
                            <option value="project">Project</option>
                            <option value="life_area">Life Area</option>
                            <option value="note">Note</option>
                          </select>
                        </div>
                      </div>
                      {(editForm.type === 'task' || editForm.type === 'project') && (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                          <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Deadline</label>
                            <input 
                              type="datetime-local"
                              value={editForm.deadline || ''}
                              onChange={(e) => setEditForm({ ...editForm, deadline: e.target.value })}
                              className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-bold dark:text-white text-sm"
                            />
                          </div>
                          <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Recurrence</label>
                            <select 
                              value={editForm.recurrence || 'none'}
                              onChange={(e) => setEditForm({ ...editForm, recurrence: e.target.value as any })}
                              className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-bold dark:text-white text-sm"
                            >
                              <option value="none">No Recurrence</option>
                              <option value="daily">Daily</option>
                              <option value="weekly">Weekly</option>
                              <option value="monthly">Monthly</option>
                              <option value="yearly">Yearly</option>
                            </select>
                          </div>
                          <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Time Budget (min)</label>
                            <input 
                              type="number"
                              value={editForm.time_budget ? Math.floor(editForm.time_budget / 60) : ''}
                              onChange={(e) => setEditForm({ ...editForm, time_budget: e.target.value ? Number(e.target.value) * 60 : undefined })}
                              className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-bold dark:text-white text-sm"
                              placeholder="Minutes"
                            />
                          </div>
                        </div>
                      )}
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Priority</label>
                        <select 
                          value={editForm.priority || ''}
                          onChange={(e) => setEditForm({ ...editForm, priority: e.target.value as any })}
                          className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-bold dark:text-white text-sm"
                        >
                          <option value="">None</option>
                          <option value="low">Low</option>
                          <option value="moderate">Moderate</option>
                          <option value="high">High</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Content / Notes</label>
                        <textarea 
                          value={editForm.original_intent || ''} 
                          onChange={(e) => setEditForm({ ...editForm, original_intent: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              handleUpdateItem();
                            }
                          }}
                          className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-medium dark:text-white min-h-[150px] resize-none"
                          placeholder="Add details here..."
                        />
                      </div>
                      {editForm.type === 'habit' && editForm.habit_config && (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4 bg-indigo-50 rounded-2xl border border-indigo-100">
                          <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-400 uppercase tracking-widest">Habit Type</label>
                            <select 
                              value={editForm.habit_config.type}
                              onChange={(e) => setEditForm({ 
                                ...editForm, 
                                habit_config: { ...editForm.habit_config!, type: e.target.value as 'boolean' | 'numeric' } 
                              })}
                              className="w-full p-2 bg-white rounded-xl border border-slate-200 text-xs font-bold"
                            >
                              <option value="boolean">Checkmark</option>
                              <option value="numeric">Number</option>
                            </select>
                          </div>
                          {editForm.habit_config.type === 'numeric' && (
                            <>
                              <div className="space-y-2">
                                <label className="text-xs font-bold text-slate-400 uppercase tracking-widest">Goal</label>
                                <input 
                                  type="number"
                                  value={editForm.habit_config.goal}
                                  onChange={(e) => setEditForm({ 
                                    ...editForm, 
                                    habit_config: { ...editForm.habit_config!, goal: Number(e.target.value) } 
                                  })}
                                  className="w-full p-2 bg-white rounded-xl border border-slate-200 text-xs font-bold"
                                />
                              </div>
                              <div className="space-y-2">
                                <label className="text-xs font-bold text-slate-400 uppercase tracking-widest">Unit</label>
                                <input 
                                  type="text"
                                  value={editForm.habit_config.unit}
                                  onChange={(e) => setEditForm({ 
                                    ...editForm, 
                                    habit_config: { ...editForm.habit_config!, unit: e.target.value } 
                                  })}
                                  className="w-full p-2 bg-white rounded-xl border border-slate-200 text-xs font-bold"
                                />
                              </div>
                            </>
                          )}
                        </div>
                      )}
                      <button 
                        onClick={handleUpdateItem}
                        className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-bold shadow-lg shadow-indigo-200"
                      >
                        Save Changes
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
        <div className="flex items-start justify-between gap-4">
                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">{selectedItem.type.replace('_', ' ')}</span>
                        </div>
                        <h2 className="text-2xl sm:text-3xl font-black leading-tight text-slate-900 dark:text-white">
                          {selectedItem.title}
                        </h2>
                        {selectedItem.type === 'task' && selectedItem.subtasks && selectedItem.subtasks.length > 0 && (
                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">
                              <span>Subtask Progress</span>
                              <span>{Math.round((selectedItem.subtasks.filter(st => st.completed).length / selectedItem.subtasks.length) * 100)}%</span>
                            </div>
                            <div className="h-2 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                              <motion.div 
                                initial={{ width: 0 }}
                                animate={{ width: `${(selectedItem.subtasks.filter(st => st.completed).length / selectedItem.subtasks.length) * 100}%` }}
                                className="h-full bg-indigo-500 rounded-full"
                              />
                            </div>
                          </div>
                        )}
                        {selectedItem.deadline && !selectedItem.completed && (
                          (() => {
                            const progress = calculateDeadlineProgress(selectedItem.createdAt, selectedItem.deadline);
                            if (!progress) return null;
                            return (
                              <div className="space-y-3 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-100 dark:border-slate-700">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2 text-slate-900 dark:text-white font-bold">
                                    <Clock className="w-4 h-4 text-indigo-500" />
                                    <span>Deadline</span>
                                  </div>
                                  <span className={cn(
                                    "text-xs font-black uppercase tracking-wider px-2 py-1 rounded-lg",
                                    progress.status === 'critical' ? "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400" : 
                                    progress.status === 'warning' ? "bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400" : 
                                    "bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400"
                                  )}>
                                    {progress.remainingText}
                                  </span>
                                </div>
                                <div className="space-y-1">
                                  <div className="flex justify-between text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                    <span>Time Elapsed</span>
                                    <span>{Math.round(progress.percentage)}%</span>
                                  </div>
                                  <div className="h-2 w-full bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                                    <motion.div 
                                      initial={{ width: 0 }}
                                      animate={{ width: `${progress.percentage}%` }}
                                      className={cn(
                                        "h-full rounded-full transition-colors duration-500",
                                        progress.status === 'critical' ? "bg-red-500" : progress.status === 'warning' ? "bg-amber-500" : "bg-indigo-500"
                                      )}
                                    />
                                  </div>
                                </div>
                                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                                  Due on {new Date(selectedItem.deadline).toLocaleString()}
                                </div>
                              </div>
                            );
                          })()
                        )}
                        {selectedItem.time_budget && (
                          (() => {
                            const totalTimeSpent = timerHistory
                              .filter(session => session.taskId === selectedItem.id)
                              .reduce((acc, session) => acc + (session.durationSeconds || 0), 0);
                            const budgetProgress = Math.min((totalTimeSpent / selectedItem.time_budget) * 100, 100);
                            const isOverBudget = totalTimeSpent > selectedItem.time_budget;

                            return (
                              <div className="space-y-3 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-100 dark:border-slate-700">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2 text-slate-900 dark:text-white font-bold">
                                    <Hourglass className="w-4 h-4 text-indigo-500" />
                                    <span>Time Budget</span>
                                  </div>
                                  <span className={cn(
                                    "text-xs font-black uppercase tracking-wider px-2 py-1 rounded-lg",
                                    isOverBudget ? "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400" : 
                                    "bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400"
                                  )}>
                                    {isOverBudget ? "Over Budget" : `${formatTime(Math.max(0, selectedItem.time_budget - totalTimeSpent))} left`}
                                  </span>
                                </div>
                                <div className="space-y-1">
                                  <div className="flex justify-between text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                    <span>Budget Used</span>
                                    <span>{Math.round((totalTimeSpent / selectedItem.time_budget) * 100)}%</span>
                                  </div>
                                  <div className="h-2 w-full bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                                    <motion.div 
                                      initial={{ width: 0 }}
                                      animate={{ width: `${budgetProgress}%` }}
                                      className={cn(
                                        "h-full rounded-full transition-colors duration-500",
                                        isOverBudget ? "bg-red-500" : "bg-indigo-500"
                                      )}
                                    />
                                  </div>
                                </div>
                                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                                  Spent {formatTime(totalTimeSpent)} of {formatTime(selectedItem.time_budget)}
                                </div>
                              </div>
                            );
                          })()
                        )}
                        {selectedItem.deadline && selectedItem.completed && (
                          <div className="flex items-center gap-2 text-emerald-500 font-bold text-sm">
                            <CheckCircle2 className="w-4 h-4" />
                            Completed before deadline: {new Date(selectedItem.deadline).toLocaleString()}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-2">
                        {selectedItem.type !== 'note' && (
                          <>
                            <button 
                              onClick={() => {
                                setHistoryFilterId(selectedItem.id);
                                setIsHistoryOpen(true);
                              }}
                              className="p-2 bg-slate-100 dark:bg-slate-800 rounded-full text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-all"
                              title="View Timer History"
                            >
                              <Clock className="w-6 h-6" />
                            </button>
                            <button 
                              onClick={() => setIsTimerSetupOpen(!isTimerSetupOpen)}
                              className={cn(
                                "p-2 rounded-full transition-all",
                                isTimerSetupOpen 
                                  ? "bg-emerald-600 text-white shadow-lg" 
                                  : "bg-slate-100 dark:bg-slate-800 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
                              )}
                              title="Timer Setup"
                            >
                              <Zap className="w-6 h-6" />
                            </button>
                            {selectedItem.type === 'habit' && (
                              <button 
                                onClick={() => setIsHabitProgressOpen(!isHabitProgressOpen)}
                                className={cn(
                                  "p-2 rounded-full transition-all",
                                  isHabitProgressOpen 
                                    ? "bg-indigo-600 text-white shadow-lg" 
                                    : "bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30"
                                )}
                                title="Habit Progress"
                              >
                                <BarChart3 className="w-6 h-6" />
                              </button>
                            )}
                          </>
                        )}
                        <button 
                          onClick={() => {
                            setIsEditing(true);
                            setEditForm(selectedItem);
                          }}
                          className="p-2 bg-slate-100 dark:bg-slate-800 rounded-full text-slate-500 dark:text-slate-400"
                        >
                          <Edit3 className="w-6 h-6" />
                        </button>
                        <button 
                          onClick={() => {
                            setSelectedItem(null);
                            setIsTimerSetupOpen(false);
                            setIsHabitProgressOpen(false);
                          }}
                          className="p-2 bg-slate-100 dark:bg-slate-800 rounded-full text-slate-500 dark:text-slate-400"
                        >
                          <Plus className="w-6 h-6 rotate-45" />
                        </button>
                      </div>
                    </div>

                    {isTimerActive && timerTaskId === selectedItem.id ? (
                      <motion.div 
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        className="p-6 bg-emerald-50 dark:bg-emerald-900/10 rounded-3xl border border-emerald-100 dark:border-emerald-900/30 space-y-6"
                      >
                        <div className="flex items-center justify-between">
                          <h3 className="font-black text-xs text-emerald-600 dark:text-emerald-400 uppercase tracking-widest flex items-center gap-2">
                            <Clock className="w-4 h-4 animate-pulse" />
                            Focused Session Active
                          </h3>
                          <button 
                            onClick={() => { 
                              setIsTimerActive(false); 
                              setTimeLeft(0); 
                              setTimerEndTime(null);
                            }}
                            className="p-2 text-emerald-600/60 hover:text-red-500 transition-colors"
                          >
                            <Plus className="w-5 h-5 rotate-45" />
                          </button>
                        </div>
                        
                        <div className="flex flex-col items-center justify-center py-4 space-y-6">
                          <div className="relative w-32 h-32">
                            <svg className="w-full h-full transform -rotate-90">
                              <circle
                                cx="64"
                                cy="64"
                                r="60"
                                stroke="currentColor"
                                strokeWidth="8"
                                fill="transparent"
                                className="text-emerald-100 dark:text-emerald-900/30"
                              />
                              <motion.circle
                                cx="64"
                                cy="64"
                                r="60"
                                stroke="currentColor"
                                strokeWidth="8"
                                fill="transparent"
                                strokeDasharray={376.99}
                                initial={{ strokeDashoffset: 0 }}
                                animate={{ strokeDashoffset: 376.99 * (1 - timeLeft / timerDuration) }}
                                transition={{ duration: 1, ease: "linear" }}
                                className="text-emerald-500 dark:text-emerald-400"
                              />
                            </svg>
                            <div className="absolute inset-0 flex items-center justify-center">
                              <span className="font-mono font-black text-3xl text-emerald-600 dark:text-emerald-400">
                                {formatTime(timeLeft)}
                              </span>
                            </div>
                          </div>
                          <div className="w-full h-3 bg-emerald-100 dark:bg-emerald-900/30 rounded-full overflow-hidden">
                            <motion.div 
                              className="h-full bg-emerald-500 dark:bg-emerald-400"
                              initial={{ width: "0%" }}
                              animate={{ width: `${(timeLeft / timerDuration) * 100}%` }}
                              transition={{ duration: 1, ease: "linear" }}
                            />
                          </div>
                        </div>
                      </motion.div>
                    ) : isTimerSetupOpen && (
                      <motion.div 
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        className="p-6 bg-emerald-50 dark:bg-emerald-900/10 rounded-3xl border border-emerald-100 dark:border-emerald-900/30 space-y-4"
                      >
                        <div className="flex items-center justify-between">
                          <h3 className="font-black text-xs text-emerald-600 dark:text-emerald-400 uppercase tracking-widest flex items-center gap-2">
                            <Clock className="w-4 h-4" />
                            Quick Timer Setup
                          </h3>
                          <div className="flex items-center gap-4">
                            {typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default' && (
                              <button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  requestNotificationPermission();
                                }}
                                className="text-[10px] font-black underline uppercase tracking-widest text-emerald-600/60 hover:text-emerald-600 transition-colors"
                              >
                                Enable Desktop Alerts
                              </button>
                            )}
                            <div className="flex items-center gap-2">
                              <input 
                                type="number" 
                                value={timerDuration / 60}
                                onChange={(e) => setTimerDuration(Math.max(1, parseInt(e.target.value) || 1) * 60)}
                                className="w-16 p-2 bg-white dark:bg-slate-800 border border-emerald-200 dark:border-emerald-800 rounded-xl text-center font-bold text-sm dark:text-white"
                              />
                              <span className="text-xs font-bold text-emerald-600/60 uppercase tracking-widest">min</span>
                            </div>
                          </div>
                        </div>
                        <button 
                          onClick={() => {
                            setTimerTaskId(selectedItem.id);
                            const endTime = Date.now() + timerDuration * 1000;
                            setTimerEndTime(endTime);
                            setTimeLeft(timerDuration);
                            setIsTimerActive(true);
                            setIsTimerSetupOpen(false);
                            
                            // "Unlock" audio for this session while in user-initiated event
                            if (timerAudioRef.current) {
                              timerAudioRef.current.play().then(() => {
                                timerAudioRef.current?.pause();
                                timerAudioRef.current!.currentTime = 0;
                              }).catch(e => console.warn("Failed to unlock audio:", e));
                            }
                          }}
                          className="w-full py-4 bg-emerald-600 text-white rounded-2xl font-bold shadow-lg shadow-emerald-200 dark:shadow-none flex items-center justify-center gap-2 hover:bg-emerald-700 transition-all"
                        >
                          <Zap className="w-5 h-5 fill-current" />
                          Start Focused Session
                        </button>
                      </motion.div>
                    )}

                    {isHabitProgressOpen && renderSingleHabitProgress(selectedItem)}

                    {/* Content Grid */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                      {/* Left Column: Subtasks or Note Content and Linked Notes */}
                      <div className="space-y-8">
                        {selectedItem.type === 'note' ? (
                          <div className="bg-amber-50 dark:bg-amber-900/20 rounded-3xl p-6 border border-amber-200 dark:border-amber-800">
                            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-bold text-sm uppercase tracking-wider mb-4">
                              <StickyNote className="w-4 h-4" />
                              Note Content
                            </div>
                            <p className="text-slate-700 dark:text-slate-200 font-medium leading-relaxed whitespace-pre-wrap">
                              {selectedItem.original_intent}
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-4">
                            <h3 className="font-black text-xs text-slate-400 dark:text-slate-500 uppercase tracking-[0.2em] flex items-center gap-2">
                              <CheckCircle2 className="w-4 h-4" />
                              Subtasks
                            </h3>
                            <div className="space-y-2">
                              {(selectedItem.subtasks || []).map((st) => (
                                <div 
                                  key={st.id} 
                                  onClick={() => toggleSubtask(st.id)}
                                  className="flex items-center gap-4 p-4 bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 cursor-pointer hover:border-indigo-200 dark:hover:border-indigo-800 transition-all shadow-sm"
                                >
                                  <div className={cn(
                                    "w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all",
                                    st.completed ? "bg-[#2B4189] border-[#2B4189] text-white" : "border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800"
                                  )}>
                                    {st.completed && <CheckCircle2 className="w-4 h-4" />}
                                  </div>
                                  <span className={cn("font-bold text-slate-700 dark:text-slate-200", st.completed && "line-through text-slate-400")}>{st.title}</span>
                                </div>
                              ))}
                              <div className="flex gap-2">
                                <input 
                                  type="text" 
                                  placeholder="Add a subtask..."
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      addSubtask(e.currentTarget.value);
                                      e.currentTarget.value = '';
                                    }
                                  }}
                                  className="flex-1 p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 focus:ring-2 focus:ring-indigo-500 text-sm dark:text-white font-bold"
                                />
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Linked Notes Section */}
                        <div className="space-y-4">
                          <div className="flex items-center justify-between">
                            <h3 className="font-bold text-lg flex items-center gap-2 dark:text-white">
                              <StickyNote className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                              Linked Notes
                            </h3>
                          </div>
                          
                          <div className="space-y-3">
                            <div className="flex gap-2">
                              <input 
                                type="text" 
                                placeholder="Add a linked note..."
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    addLinkedNote(e.currentTarget.value);
                                    e.currentTarget.value = '';
                                  }
                                }}
                                className="flex-1 p-4 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 focus:ring-2 focus:ring-indigo-500 text-sm dark:text-white font-bold"
                              />
                            </div>

                            <div className="grid gap-3">
                              {items.filter(i => i.parentId === selectedItem.id && i.type === 'note').map(note => (
                                <div key={note.id} className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-100 dark:border-slate-800 group relative">
                                  <div className="text-sm font-bold text-slate-900 dark:text-white mb-1">{note.title}</div>
                                  <div className="text-xs text-slate-500 dark:text-slate-400 line-clamp-3">{note.original_intent}</div>
                                  <button 
                                    onClick={() => deleteItem(note.id)}
                                    className="absolute top-2 right-2 p-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Right Column: EF Tips */}
                      <div className="space-y-4">
                        <h3 className="font-black text-xs text-slate-400 dark:text-slate-500 uppercase tracking-[0.2em] flex items-center gap-2">
                          <Lightbulb className="w-4 h-4" />
                          Executive Function Tips
                        </h3>
                        <div className="grid grid-cols-1 gap-3">
                          {EF_BEST_PRACTICES.map((practice, idx) => (
                            <div key={`ef-tip-${idx}`} className="p-4 bg-indigo-50/50 dark:bg-indigo-900/10 rounded-2xl border border-indigo-100 dark:border-indigo-900/30">
                              <div className="text-sm font-bold text-indigo-900 dark:text-indigo-300 mb-1">{practice.title}</div>
                              <div className="text-xs text-indigo-700 dark:text-indigo-400 leading-relaxed">{practice.description}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div className="p-6 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-800 flex gap-3">
                {selectedItem.type !== 'note' && (
                  <button
                    onClick={() => {
                      toggleComplete(selectedItem);
                      setSelectedItem(null);
                    }}
                    className={cn(
                      "flex-1 py-4 rounded-2xl font-bold flex items-center justify-center gap-2 transition-all active:scale-95",
                      selectedItem.completed 
                        ? "bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300" 
                        : "bg-indigo-600 text-white shadow-lg shadow-indigo-200 dark:shadow-none"
                    )}
                  >
                    <CheckCircle2 className="w-5 h-5" />
                    {selectedItem.completed ? 'Mark Incomplete' : 'Mark as Done'}
                  </button>
                )}
                <button
                  onClick={() => deleteItem(selectedItem.id)}
                  className={cn(
                    "p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-red-500 rounded-2xl hover:bg-red-50 dark:hover:bg-red-900/20 transition-all active:scale-95",
                    selectedItem.type === 'note' && "flex-1"
                  )}
                >
                  <Trash2 className="w-6 h-6 mx-auto" />
                  {selectedItem.type === 'note' && <span className="ml-2 font-bold">Delete Note</span>}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
