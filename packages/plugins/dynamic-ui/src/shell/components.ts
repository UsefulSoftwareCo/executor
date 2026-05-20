/**
 * Barrel export of all UI components available to model-generated React code.
 * These are re-exports of the existing shadcn components from @executor-js/react,
 * plus Recharts primitives and Lucide icons.
 */

// ---------------------------------------------------------------------------
// shadcn/ui components
// ---------------------------------------------------------------------------

// Layout
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
} from "@executor-js/react/components/card";
export { Separator } from "@executor-js/react/components/separator";
export { Tabs, TabsList, TabsTrigger, TabsContent } from "@executor-js/react/components/tabs";
export {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@executor-js/react/components/accordion";
export { ScrollArea, ScrollBar } from "@executor-js/react/components/scroll-area";

// Overlay
export {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@executor-js/react/components/dialog";
export {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  SheetClose,
} from "@executor-js/react/components/sheet";
export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
} from "@executor-js/react/components/popover";
export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@executor-js/react/components/tooltip";
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@executor-js/react/components/dropdown-menu";

// Input
export { Button } from "@executor-js/react/components/button";
export { Input } from "@executor-js/react/components/input";
export { Textarea } from "@executor-js/react/components/textarea";
export { Label } from "@executor-js/react/components/label";
export {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
} from "@executor-js/react/components/select";
export { Checkbox } from "@executor-js/react/components/checkbox";
export { RadioGroup, RadioGroupItem } from "@executor-js/react/components/radio-group";
export { Switch } from "@executor-js/react/components/switch";
export { Slider } from "@executor-js/react/components/slider";
export { Toggle } from "@executor-js/react/components/toggle";
export { ToggleGroup, ToggleGroupItem } from "@executor-js/react/components/toggle-group";

// Data display
export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "@executor-js/react/components/table";
export { Badge } from "@executor-js/react/components/badge";
export { Avatar, AvatarImage, AvatarFallback } from "@executor-js/react/components/avatar";
export { Progress } from "@executor-js/react/components/progress";
export { Skeleton } from "@executor-js/react/components/skeleton";

// Feedback
export { Alert, AlertTitle, AlertDescription } from "@executor-js/react/components/alert";

// Charts (shadcn wrappers around Recharts)
export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
} from "@executor-js/react/components/chart";

// ---------------------------------------------------------------------------
// Recharts primitives (exposed directly for model use)
// ---------------------------------------------------------------------------

export {
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  RadialBarChart,
  RadialBar,
  ScatterChart,
  Scatter,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
  ReferenceArea,
  Brush,
  Funnel,
  FunnelChart,
  Treemap,
} from "recharts";

// ---------------------------------------------------------------------------
// Lucide icons (common subset)
// ---------------------------------------------------------------------------

export {
  Plus,
  Minus,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Search,
  Loader2,
  AlertCircle,
  AlertTriangle,
  Info,
  ExternalLink,
  Copy,
  Trash2,
  Edit,
  Settings,
  User,
  Users,
  Mail,
  Calendar,
  Clock,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Download,
  Upload,
  File,
  FileText,
  Folder,
  FolderOpen,
  Image,
  Link,
  Globe,
  Home,
  Star,
  Heart,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  RefreshCw,
  RotateCcw,
  Filter,
  SortAsc,
  SortDesc,
  MoreHorizontal,
  MoreVertical,
  Menu,
  Grip,
  GripVertical,
  Code,
  Terminal,
  Database,
  Server,
  Cpu,
  Zap,
  Activity,
  TrendingUp,
  TrendingDown,
  BarChart3,
  PieChart as PieChartIcon,
  GitBranch,
  GitCommit,
  GitPullRequest,
  MessageSquare,
  Send,
  Bookmark,
  Tag,
  Hash,
  AtSign,
  Paperclip,
  MapPin,
  Phone,
  Video,
  Mic,
  Volume2,
  VolumeX,
  Play,
  Pause,
  Square,
  Circle,
  Triangle,
  Hexagon,
  Box,
  Package,
  Shield,
  Key,
  Wifi,
  WifiOff,
  Battery,
  Sun,
  Moon,
  CloudRain,
  Thermometer,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export { cn } from "@executor-js/react/lib/utils";
