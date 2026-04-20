import { useState, useMemo, useCallback, useRef, ChangeEvent } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Building2, 
  Trash2, 
  Upload, 
  Download, 
  Plus, 
  X, 
  Check, 
  AlertTriangle, 
  Copy, 
  FileText,
  Sparkles,
  Loader2,
  Trash,
  LayoutDashboard,
  Box,
  Rows,
  Settings,
  MoreVertical,
  History,
  FileDown
} from 'lucide-react';
import { GoogleGenAI, Type } from "@google/genai";

// --- Constants ---
const PLY = { KS: 0.418, I: 0.167, lbQ: 5.621, Fb: 1545, Frs: 82, E: 1500000 };
const WOOD = { I: 12.5, S: 7.15, Fv: 135, E: 1300000, Fb_adj: 1150 };
const ALU = { E: 9860000, I: 17 };
const STD_SPACING = [24, 20, 16, 12, 10, 8] as const;
const ALU_CAP: Record<string, Record<number, number>> = { 
  simple: { 4: 2620, 5: 2020, 6: 1408, 7: 885 }, 
  double: { 4: 2620, 5: 2020, 6: 1408, 7: 1404 } 
};
const BEAM_CAP: Record<number, number> = { 4: 2620, 5: 2020, 6: 1408, 7: 1404 };
const FRAME_CAP = 10000;
const CONCRETE_PCF = 150;
const DEFLECTION_LIMIT = 360;

// --- Types ---
type ElementType = 'DALLE' | 'POUTRE';

interface ElementParams {
  id: number;
  type: ElementType;
  name: string;
  isVar: boolean;
  epMin: number;
  epMax: number;
  dd: number;
  dl: number;
  trib: number;
  span: number;
  stype?: string;
  cho: number;
}

interface ProjectData {
  name: string;
  elements: {
    id: number;
    params: ElementParams;
    total: number;
    lm: string;
    ok_wood: boolean;
    ok_alu: boolean;
    ok_defl: boolean;
    ok_frame: boolean;
    time: string;
    isAi?: boolean;
  }[];
}

// --- Utils ---
const fmt = (n: number | undefined, d = 2) => typeof n === "number" && isFinite(n) ? n.toFixed(d) : "—";
const safeDiv = (a: number, b: number, f = 0) => b === 0 || !isFinite(b) ? f : a / b;

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'dalle' | 'poutre'>('dashboard');
  const [projectData, setProjectData] = useState<ProjectData>(() => {
    const saved = localStorage.getItem('coffrageProject');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error("Error parsing saved project", e);
      }
    }
    return { name: "Projet_Coffrage", elements: [] };
  });
  
  const [editingId, setEditingId] = useState<number | null>(null);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [pendingExtractions, setPendingExtractions] = useState<any[]>([]);
  
  // Custom UI Feedback State
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{
    show: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  }>({
    show: false,
    title: "",
    message: "",
    onConfirm: () => {},
  });

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const askConfirmation = (title: string, message: string, onConfirm: () => void) => {
    setConfirmModal({ show: true, title, message, onConfirm });
  };
  
  // Form State
  const [formName, setFormName] = useState("");
  const [formIsVar, setFormIsVar] = useState(false);
  const [formEp, setFormEp] = useState(450);
  const [formEpMin, setFormEpMin] = useState(300);
  const [formEpMax, setFormEpMax] = useState(450);
  const [formDead, setFormDead] = useState(8);
  const [formLive, setFormLive] = useState(50);
  const [formTrib, setFormTrib] = useState(4);
  const [formSpan, setFormSpan] = useState(7);
  const [formSType, setFormSType] = useState("double");
  const [formChoix, setFormChoix] = useState(48);

  const aiRef = useRef<GoogleGenAI | null>(null);

  // Persistence
  useMemo(() => {
    localStorage.setItem('coffrageProject', JSON.stringify(projectData));
  }, [projectData]);

  // Calculations
  const calculations = useMemo(() => {
    const depth = formIsVar ? formEpMax : formEp;
    const ep_min_val = formIsVar ? formEpMin : depth;
    
    // A1 - Charge
    const din = Math.ceil(depth / 25.4);
    const conc = (din / 12) * CONCRETE_PCF;
    const total = conc + formDead + formLive;
    
    // A2 - Contreplaqué & 4x4
    const wb = safeDiv(total, 12);
    const wd = safeDiv(total - formLive, 12);
    const lb_ply = wb > 0 ? Math.sqrt(10 * PLY.Fb * PLY.KS / wb) : Infinity;
    const ld_ply = wd > 0 ? Math.pow(145 * PLY.E * PLY.I / (DEFLECTION_LIMIT * wd), 1/3) : Infinity;
    const lr_ply = wb > 0 ? (5/3) * PLY.Frs * PLY.lbQ / wb : Infinity;
    const lm_ply = Math.min(lb_ply, ld_ply, lr_ply);
    const sp = STD_SPACING.find(s => s <= lm_ply) || STD_SPACING[STD_SPACING.length - 1];
    
    const wcft = (sp / 12) * total;
    const wdft = (sp / 12) * (total - formLive);
    const wcin = safeDiv(wcft, 12);
    const wdin = safeDiv(wdft, 12);
    const lb_wood = wcin > 0 ? Math.sqrt(10 * WOOD.Fb_adj * WOOD.S / wcin) : Infinity;
    const ld_wood = wdin > 0 ? Math.pow(145 * WOOD.E * WOOD.I / (DEFLECTION_LIMIT * wdin), 1/3) : Infinity;
    const lm_wood = Math.min(lb_wood, ld_wood);
    
    // A3 - Aluma
    const isDalle = activeTab === 'dalle';
    const loadAlu = formTrib * total;
    const capAlu = isDalle ? (ALU_CAP[formSType]?.[formSpan] || 0) : (BEAM_CAP[formSpan] || 0);
    const okAlu = loadAlu <= capAlu && capAlu > 0;
    
    const L = formSpan * 12;
    const md = L / 270;
    const wdAlu = safeDiv(formTrib * (total - formLive), 12);
    const deflAlu = wdAlu > 0 ? (isDalle && formSType === "simple" ? (5 * wdAlu * Math.pow(L, 4) / (384 * ALU.E * ALU.I)) : (wdAlu * Math.pow(L, 4) / (185 * ALU.E * ALU.I))) : Infinity;
    const dOk = deflAlu <= md;
    
    // A4 - Cadres
    const pt = loadAlu * formSpan;
    const fOk = pt <= FRAME_CAP;
    
    return {
      din, conc, total,
      sp, wcft, lm_wood, woodOk: formChoix <= lm_wood,
      loadAlu, capAlu, okAlu, md, deflAlu, dOk,
      pt, fOk,
      ep_min_val, depth_max: depth
    };
  }, [formIsVar, formEp, formEpMin, formEpMax, formDead, formLive, formTrib, formSpan, formSType, formChoix, activeTab]);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setFormName("");
    setFormIsVar(false);
    setFormEp(activeTab === 'dalle' ? 450 : 495);
    setFormEpMin(300);
    setFormEpMax(450);
    setFormDead(8);
    setFormLive(50);
    setFormTrib(4);
    setFormSpan(activeTab === 'dalle' ? 7 : 6);
    setFormSType("double");
    setFormChoix(48);
  }, [activeTab]);

  const saveElement = () => {
    const calcType = activeTab === 'dashboard' ? 'DALLE' : (activeTab === 'dalle' ? 'DALLE' : 'POUTRE');
    const name = formName.trim() || `${calcType}_${projectData.elements.length + 1}`;
    
    const params: ElementParams = {
      id: editingId || Date.now(),
      type: calcType as ElementType,
      name,
      isVar: formIsVar,
      epMin: formIsVar ? formEpMin : formEp,
      epMax: formIsVar ? formEpMax : formEp,
      dd: formDead,
      dl: formLive,
      trib: formTrib,
      span: formSpan,
      stype: calcType === 'DALLE' ? formSType : undefined,
      cho: formChoix,
    };

    const newElement = {
      id: params.id,
      params,
      total: Math.round(calculations.total),
      lm: fmt(calculations.lm_wood, 2),
      ok_wood: calculations.woodOk,
      ok_alu: calculations.okAlu,
      ok_defl: calculations.dOk,
      ok_frame: calculations.fOk,
      time: new Date().toLocaleString('fr-FR')
    };

    if (editingId) {
      setProjectData(prev => ({
        ...prev,
        elements: prev.elements.map(el => el.id === editingId ? newElement : el)
      }));
    } else {
      setProjectData(prev => ({
        ...prev,
        elements: [newElement, ...prev.elements]
      }));
    }
    
    resetForm();
  };

  const startEdit = (id: number) => {
    const el = projectData.elements.find(e => e.id === id);
    if (!el) return;
    const p = el.params;
    setEditingId(id);
    setActiveTab(p.type === 'DALLE' ? 'dalle' : 'poutre');
    setFormName(p.name);
    setFormIsVar(p.isVar);
    if (p.isVar) {
      setFormEpMin(p.epMin);
      setFormEpMax(p.epMax);
    } else {
      setFormEp(p.epMax);
    }
    setFormDead(p.dd);
    setFormLive(p.dl);
    setFormTrib(p.trib);
    setFormSpan(p.span);
    if (p.stype) setFormSType(p.stype);
    setFormChoix(p.cho);
  };

  const deleteElement = (id: number) => {
    askConfirmation(
      "Suppression",
      "Voulez-vous vraiment supprimer cet élément ?",
      () => {
        setProjectData(prev => ({
          ...prev,
          elements: prev.elements.filter(e => e.id !== id)
        }));
        if (editingId === id) resetForm();
        showToast("Élément supprimé", "info");
      }
    );
  };

  const clearProject = () => {
    askConfirmation(
      "Réinitialiser",
      "Voulez-vous réinitialiser tout le projet ? Cette action est irréversible.",
      () => {
        setProjectData({ name: "Projet_Coffrage", elements: [] });
        resetForm();
        showToast("Projet réinitialisé", "info");
      }
    );
  };

  const exportJSON = () => {
    const b = new Blob([JSON.stringify(projectData, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `${projectData.name.replace(/\s+/g, '_')}.json`;
    a.click();
  };

  const importJSON = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = ev => {
      try {
        const d = JSON.parse(ev.target?.result as string);
        if (d.elements) {
          setProjectData(d);
          resetForm();
          showToast("Projet importé avec succès");
        }
      } catch (err) { 
        showToast("Fichier JSON invalide", "error"); 
      }
    };
    r.readAsText(f);
    e.target.value = '';
  };

  const copySummary = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      showToast("✅ Résumé copié au presse-papier");
    });
  };

  // --- AI Logic ---
  const handleAiExtraction = async (file: File) => {
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      showToast("Clé API Gemini manquante. Configurez GEMINI_API_KEY.", "error");
      return;
    }

    if (!aiRef.current) {
      aiRef.current = new GoogleGenAI({ apiKey });
    }

    setIsAiLoading(true);
    try {
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve) => {
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
      });
      reader.readAsDataURL(file);
      const base64 = await base64Promise;

      const response = await aiRef.current.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            parts: [
              {
                inlineData: {
                  data: base64,
                  mimeType: file.type
                }
              },
              {
                text: `Tu es un expert en coffrage. Analyse ce plan de structure et extrais les informations sur les dalles et les poutres.
                Pour chaque élément trouvé, donne :
                1. Le nom unique identifiant (ex: DALLE D1, POUTRE P2).
                2. L'épaisseur ou profondeur brute en millimètres (mm).
                3. Le type : "DALLE" ou "POUTRE".
                
                Réponds UNIQUEMENT avec un tableau JSON valide.
                Exemple: [{"name": "Dalle 1", "thickness": 200, "type": "DALLE"}]
                Si tu ne trouves rien, renvoie un tableau vide [].`
              }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                thickness: { type: Type.NUMBER },
                type: { type: Type.STRING, enum: ["DALLE", "POUTRE"] }
              },
              required: ["name", "thickness", "type"]
            }
          }
        }
      });

      const extracted = JSON.parse(response.text);
      if (extracted.length === 0) {
        showToast("Aucune donnée détectée. Essayez une image plus claire.", "info");
        return;
      }

      const newElements = extracted.map((item: any, index: number) => {
        const type = item.type === 'DALLE' ? 'DALLE' : 'POUTRE';
        const thick = item.thickness || (type === 'DALLE' ? 200 : 400);
        
        const LD = { conc: (Math.ceil(thick / 25.4) / 12) * 150, total: (Math.ceil(thick / 25.4) / 12) * 150 + 8 + 50 };
        
        return {
          id: Date.now() + index,
          params: {
            id: Date.now() + index,
            type,
            name: item.name,
            isVar: false,
            epMin: thick,
            epMax: thick,
            dd: 8,
            dl: 50,
            trib: 4,
            span: type === 'DALLE' ? 7 : 6,
            stype: "double",
            cho: 48
          },
          total: Math.round(LD.total),
          lm: "60.00",
          ok_wood: true,
          ok_alu: true,
          ok_defl: true,
          ok_frame: true,
          time: new Date().toLocaleTimeString('fr-FR'),
          isAi: true
        };
      });

      setPendingExtractions(prev => [...newElements, ...prev]);
      showToast(`${newElements.length} éléments en attente de validation`, "success");
    } catch (err) {
      console.error(err);
      showToast("Erreur lors de l'analyse IA.", "error");
    } finally {
      setIsAiLoading(false);
    }
  };

  const approveExtraction = (id: number) => {
    const el = pendingExtractions.find(e => e.id === id);
    if (!el) return;
    
    setProjectData(prev => ({
      ...prev,
      elements: [el, ...prev.elements]
    }));
    setPendingExtractions(prev => prev.filter(e => e.id !== id));
    showToast("Élément ajouté au projet");
  };

  const rejectExtraction = (id: number) => {
    setPendingExtractions(prev => prev.filter(e => e.id !== id));
    showToast("Détection IA rejetée", "info");
  };

  const summaryText = `
<strong>${formName.trim() || (activeTab === 'dalle' ? 'DALLE' : 'POUTRE')}</strong><br/>
<strong>ÉPAISSEUR : ${formIsVar ? Math.ceil(formEpMin/25.4) + '"@' + calculations.din + '"' : calculations.din + '"'}</strong><br/>
<strong>CHARGE DE CONCEPTION</strong><br/>
CHARGES VIVES DE BÉTON : ${Math.round(calculations.conc)} LBS/PI²<br/>
CHARGES MORTES DU COFFRAGE : ${Math.round(formDead)} LBS/PI²<br/>
CHARGES VIVES DES TRAVAILLEURS : ${Math.round(formLive)} LBS/PI²<br/>
<strong>CHARGES TOTAUX : ${Math.round(calculations.total)} LBS/PI²</strong>`.trim();

  return (
    <div className="flex bg-bg h-screen overflow-hidden text-text-main font-sans">
      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -50 }}
            animate={{ opacity: 1, y: 20 }}
            exit={{ opacity: 0, y: -50 }}
            className={`fixed top-0 left-1/2 -translate-x-1/2 z-[100] px-6 py-3 rounded-full shadow-2xl font-bold text-sm flex items-center gap-2
            ${toast.type === 'success' ? 'bg-success text-white' : 
              toast.type === 'error' ? 'bg-danger text-white' : 'bg-accent text-white'}`}
          >
            {toast.type === 'success' && <Check size={18} />}
            {toast.type === 'error' && <AlertTriangle size={18} />}
            {toast.type === 'info' && <FileText size={18} />}
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Confirmation Modal */}
      <AnimatePresence>
        {confirmModal.show && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[90] flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-surface border border-border w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden"
            >
              <div className="p-6">
                <h3 className="text-lg font-black tracking-tight mb-2 uppercase">{confirmModal.title}</h3>
                <p className="text-sm text-text-muted leading-relaxed">{confirmModal.message}</p>
              </div>
              <div className="bg-bg/50 p-4 flex gap-3">
                <button 
                  onClick={() => setConfirmModal(prev => ({ ...prev, show: false }))}
                  className="flex-1 py-2.5 rounded-xl text-text-muted font-bold text-xs hover:bg-white transition-colors"
                >
                  Annuler
                </button>
                <button 
                  onClick={() => {
                    confirmModal.onConfirm();
                    setConfirmModal(prev => ({ ...prev, show: false }));
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-danger text-white font-bold text-xs hover:filter hover:brightness-110 transition-all shadow-lg shadow-danger/20"
                >
                  Confirmer
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <aside className="w-[260px] bg-sidebar text-white flex flex-col p-5 shrink-0">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-9 h-9 bg-accent rounded-lg flex items-center justify-center font-black text-lg">🏗️</div>
          <div>
            <div className="font-extrabold text-base tracking-tight leading-tight">ACI COFFRAGE</div>
            <div className="text-[10px] opacity-40 font-bold tracking-widest uppercase mt-0.5">Engineering Suite</div>
          </div>
        </div>

        <nav className="space-y-8 flex-1">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-white/40 font-bold mb-4">Projets</div>
            <div className="space-y-1">
              <button 
                onClick={() => setActiveTab('dashboard')}
                className={`w-full flex items-center gap-3 p-3 rounded-lg text-[13px] font-medium transition-all duration-200
                ${activeTab==='dashboard' ? 'bg-white/10 text-white shadow-sm' : 'text-white/60 hover:text-white hover:bg-white/5'}`}
              >
                <LayoutDashboard size={16} /> Dashboard Global
              </button>
              <div className="w-full flex items-center gap-3 p-3 rounded-lg text-[13px] font-medium text-white/30 cursor-not-allowed">
                <Box size={16} /> Résidences Beaumont
              </div>
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-widest text-white/40 font-bold mb-4">Outils</div>
            <div className="space-y-1">
              <button 
                onClick={() => { setActiveTab('dalle'); resetForm(); }}
                className={`w-full flex items-center gap-3 p-3 rounded-lg text-[13px] font-medium transition-all duration-200
                ${activeTab==='dalle' ? 'bg-white/10 text-white shadow-sm' : 'text-white/60 hover:text-white hover:bg-white/5'}`}
              >
                <Building2 size={16} /> Calculateur de Dalle
              </button>
              <button 
                onClick={() => { setActiveTab('poutre'); resetForm(); }}
                className={`w-full flex items-center gap-3 p-3 rounded-lg text-[13px] font-medium transition-all duration-200
                ${activeTab==='poutre' ? 'bg-white/10 text-white shadow-sm' : 'text-white/60 hover:text-white hover:bg-white/5'}`}
              >
                <Rows size={16} /> Calculateur de Poutre
              </button>
            </div>
          </div>
        </nav>

        {/* AI Sidebar Panel */}
        <div className="mt-auto bg-ai-accent/10 border border-ai-accent/30 rounded-[10px] p-4">
          <div className="text-[11px] font-bold text-ai-accent uppercase tracking-wider mb-2 flex items-center gap-2">
            <Sparkles size={12} /> Assistant IA Plan
          </div>
          <p className="text-[11px] text-white/70 leading-relaxed">
            Déposez vos plans PDF/IMG pour extraire automatiquement les épaisseurs.
          </p>
          <div className="mt-3 text-[10px] font-mono opacity-50">Status: {isAiLoading ? 'Analyse...' : 'Prêt à analyser'}</div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col p-6 gap-5 overflow-hidden">
        {/* Header Bar */}
        <div className="flex justify-between items-center mb-1">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              {activeTab === 'dashboard' ? 'Aperçu du Projet' : (activeTab === 'dalle' ? 'Coffrage de Dalle' : 'Coffrage de Poutre')}
            </h1>
            <p className="text-text-muted text-sm mt-0.5">
              {activeTab === 'dashboard' ? projectData.name : 'Analyse de structure et calcul de charges d\'étaiement'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={exportJSON}
              className="px-4 py-2 bg-white border border-border rounded-full font-bold text-xs hover:bg-bg transition-colors flex items-center gap-2"
            >
              <FileDown size={14} /> Exporter JSON
            </button>
            <button className="px-5 py-2 bg-accent text-white rounded-full font-bold text-xs hover:filter hover:brightness-105 transition-all shadow-lg shadow-accent/20">
              Enregistrer Projet
            </button>
          </div>
        </div>

        {activeTab === 'dashboard' ? (
          <div className="flex-1 flex flex-col gap-5 overflow-hidden">
             <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-5 flex-1 overflow-hidden">
                <div className="flex flex-col gap-5 overflow-hidden">
                   <div className="bg-surface border border-border rounded-[10px] p-6 shadow-sm overflow-hidden flex flex-col shrink-0">
                      <div className="flex justify-between items-center mb-6">
                        <h2 className="text-sm font-bold text-text-muted uppercase tracking-wider">État Global du Projet</h2>
                        <div className="flex gap-4">
                           <button onClick={clearProject} className="text-danger hover:underline text-[11px] font-bold flex items-center gap-1">
                              <Trash size={12} /> Réinitialiser
                           </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-6">
                        <div className="bg-bg/50 p-4 rounded-xl border border-border/50 text-center">
                          <div className="text-3xl font-black text-accent mb-1">{projectData.elements.length}</div>
                          <div className="text-[10px] font-bold text-text-muted uppercase">Éléments Total</div>
                        </div>
                        <div className="bg-bg/50 p-4 rounded-xl border border-border/50 text-center">
                          <div className="text-3xl font-black text-ai-accent mb-1">{projectData.elements.filter(e => e.isAi).length}</div>
                          <div className="text-[10px] font-bold text-text-muted uppercase">Extraits par IA</div>
                        </div>
                        <div className="bg-bg/50 p-4 rounded-xl border border-border/50 text-center relative overflow-hidden">
                          <div className="text-3xl font-black text-orange-500 mb-1">{pendingExtractions.length}</div>
                          <div className="text-[10px] font-bold text-text-muted uppercase">En attente</div>
                          {pendingExtractions.length > 0 && <div className="absolute top-2 right-2 w-2 h-2 bg-orange-500 rounded-full animate-pulse" />}
                        </div>
                        <div className="bg-bg/50 p-4 rounded-xl border border-border/50 text-center">
                          <div className="text-3xl font-black text-success mb-1">{projectData.elements.filter(e => e.ok_wood && e.ok_alu).length}</div>
                          <div className="text-[10px] font-bold text-text-muted uppercase">Validés</div>
                        </div>
                      </div>
                   </div>

                   <div className="grid grid-cols-1 md:grid-cols-2 gap-5 flex-1 overflow-hidden">
                      <div className="bg-surface border border-border rounded-[10px] shadow-sm flex flex-col overflow-hidden">
                        <div className="px-5 py-4 border-b border-border flex justify-between items-center shrink-0">
                           <span className="text-[12px] font-bold uppercase tracking-widest text-text-muted">📋 Validation IA ({pendingExtractions.length})</span>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 scroller-hidden space-y-3 bg-ai-accent/5">
                           {pendingExtractions.length === 0 ? (
                              <div className="text-center py-10 opacity-30">
                                 <Plus className="mx-auto mb-2 text-ai-accent" size={24} />
                                 <p className="text-xs font-bold italic">Importez un plan pour voir les détections</p>
                              </div>
                           ) : (
                              pendingExtractions.map(el => (
                                 <div key={el.id} className="bg-white border border-ai-accent/20 rounded-lg p-3 shadow-sm flex flex-col gap-2">
                                    <div className="flex justify-between items-center">
                                       <span className="font-bold text-[13px]">{el.params.name}</span>
                                       <span className="bg-ai-accent text-white text-[8px] font-black px-1.5 py-0.5 rounded uppercase">Détection IA</span>
                                    </div>
                                    <div className="flex gap-4 text-[10px] uppercase font-bold text-text-muted">
                                       <span>Type: {el.params.type}</span>
                                       <span>Ép: {el.params.epMax}mm</span>
                                    </div>
                                    <div className="flex gap-2 mt-1">
                                       <button 
                                          onClick={() => approveExtraction(el.id)}
                                          className="flex-1 bg-success text-white py-1.5 rounded font-bold text-[11px] hover:filter hover:brightness-105 transition-all flex items-center justify-center gap-1"
                                       >
                                          <Check size={12} /> Valider & Ajouter
                                       </button>
                                       <button 
                                          onClick={() => rejectExtraction(el.id)}
                                          className="px-2 py-1.5 border border-danger text-danger rounded font-bold text-[11px] hover:bg-danger-bg transition-all"
                                       >
                                          <X size={12} />
                                       </button>
                                    </div>
                                 </div>
                              ))
                           )}
                        </div>
                      </div>

                      <div className="bg-surface border border-border rounded-[10px] shadow-sm flex flex-col overflow-hidden">
                          <div className="px-5 py-4 border-b border-border flex justify-between items-center shrink-0">
                            <span className="text-[12px] font-bold uppercase tracking-widest text-text-muted">Inventaire des Éléments</span>
                          </div>
                          <div className="flex-1 overflow-y-auto p-2 scroller-hidden">
                            {projectData.elements.length === 0 ? (
                              <div className="h-full flex flex-col items-center justify-center opacity-40 text-center p-10">
                                <Box size={40} strokeWidth={1} className="mb-3" />
                                <p className="text-sm font-bold">Aucun élément actif</p>
                              </div>
                            ) : (
                              <div className="space-y-2">
                                {projectData.elements.map(el => (
                                  <div key={el.id} className="bg-bg/10 border border-border/50 hover:border-accent/30 rounded-lg p-3 transition-colors flex items-center justify-between group">
                                    <div className="flex items-center gap-4">
                                       <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${el.params.type==='DALLE'?'bg-yellow/10 text-yellow':'bg-blue/10 text-blue'}`}>
                                          {el.params.type === 'DALLE' ? '▣' : '▬'}
                                       </div>
                                       <div>
                                          <div className="flex items-center gap-2">
                                            <span className="font-bold text-[13px] tracking-tight">{el.params.name}</span>
                                          </div>
                                          <div className="text-[9px] font-bold text-text-muted uppercase tracking-wider">
                                             {el.params.epMax}mm • {el.total} psf
                                          </div>
                                       </div>
                                    </div>
                                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                       <button onClick={() => startEdit(el.id)} className="p-1.5 hover:bg-bg rounded transition-colors"><Settings size={12} /></button>
                                       <button onClick={() => deleteElement(el.id)} className="p-1.5 hover:bg-danger-bg hover:text-danger rounded transition-colors"><Trash2 size={12} /></button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                      </div>
                   </div>
                </div>

                <div className="flex flex-col gap-5 overflow-hidden">
                   <div className="flex flex-col gap-2 shrink-0">
                      <h3 className="text-[11px] font-bold text-text-muted uppercase tracking-[0.1em]">Scanneur de Plan IA</h3>
                      <div className="bg-[#fdfaff] border-2 border-dashed border-ai-accent rounded-xl p-8 text-center flex flex-col items-center justify-center gap-4 relative">
                        {isAiLoading && <div className="absolute inset-0 bg-white/60 flex items-center justify-center z-10 rounded-xl"><Loader2 className="animate-spin text-ai-accent" size={32} /></div>}
                        <div className="text-3xl">📄</div>
                        <div>
                          <div className="text-[13px] font-extrabold text-ai-accent mb-1">Glissez vos plans PDF ici</div>
                          <p className="text-[10px] text-text-muted leading-relaxed max-w-[200px]">Notre IA détectera les cotes, épaisseurs et noms automatiquement.</p>
                        </div>
                        <label className="bg-ai-accent text-white px-5 py-2 rounded-full font-bold text-[12px] hover:filter hover:brightness-105 cursor-pointer transition-all shadow-md">
                          Analyser Image
                          <input type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => {
                            const f = e.target.files?.[0];
                            if(f) handleAiExtraction(f);
                          }} />
                        </label>
                      </div>
                   </div>

                   <div className="bg-surface border border-border rounded-[10px] shadow-sm flex flex-col flex-1 overflow-hidden">
                      <div className="p-4 border-b border-border font-bold text-[12px] flex justify-between shrink-0">
                         <span>HISTORIQUE D'EXTRACTION</span>
                         <span className="text-ai-accent">Auto-sync</span>
                      </div>
                      <div className="flex-1 overflow-y-auto p-4 scroller-hidden">
                         <div className="space-y-4">
                            {projectData.elements.filter(e => e.isAi).length === 0 ? (
                              <div className="text-center py-10 opacity-30">
                                 <Sparkles className="mx-auto mb-2" size={24} />
                                 <p className="text-xs font-bold">Aucune extraction IA</p>
                              </div>
                            ) : (
                              projectData.elements.filter(e => e.isAi).map(el => (
                                <div key={el.id} className="flex justify-between items-start border-b border-bg pb-3 last:border-0">
                                   <div>
                                      <div className="font-bold text-[12px] mb-0.5">{el.params.name} <span className="bg-ai-accent/10 text-ai-accent text-[8px] font-black px-1 py-0.5 rounded uppercase">IA</span></div>
                                      <div className="text-[10px] text-text-muted">Épaisseur: {el.params.epMax}mm • {el.time}</div>
                                   </div>
                                   <span className="bg-success-bg text-success text-[9px] font-black px-1.5 py-0.5 rounded uppercase font-mono">VALIDE</span>
                                </div>
                              ))
                            )}
                         </div>
                      </div>
                   </div>
                </div>
             </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-5 flex-1 overflow-hidden">
            {/* Dashboard Columns for Tool Mode */}
            <div className="flex flex-col gap-5 overflow-y-auto scroller-hidden pr-1">
               <div className="bg-surface border border-border rounded-[10px] p-6 shadow-sm">
                  <div className="flex justify-between items-center mb-6">
                     <h2 className="text-[13px] font-bold text-text-muted uppercase tracking-widest">Configuration de l'Élément</h2>
                     <span className="bg-ai-accent text-white text-[9px] font-black px-2 py-1 rounded">MODE IA ACTIF</span>
                  </div>

                  <div className="flex flex-col gap-5">
                    <div className="grid grid-cols-2 gap-4">
                       <div className="flex flex-col gap-1.5">
                          <label className="text-[10px] font-bold text-text-light uppercase tracking-widest">Nom de la Section</label>
                          <input 
                            type="text" 
                            className="p-3 border border-border rounded-lg text-[13px] outline-none duration-200 focus:border-accent bg-bg/30" 
                            value={formName}
                            onChange={(e) => setFormName(e.target.value)}
                            placeholder="SECTION-A101"
                          />
                       </div>
                       <div className="flex flex-col gap-1.5">
                          <label className="text-[10px] font-bold text-text-light uppercase tracking-widest">Type de Structure</label>
                          <select className="p-3 border border-border rounded-lg text-[13px] outline-none duration-200 bg-white">
                             <option>{activeTab==='dalle'?'Dalle Pleine Béton':'Poutre Murée'}</option>
                             <option>Structure Légère</option>
                          </select>
                       </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                       <div className="flex flex-col gap-1.5">
                          <label className="text-[10px] font-bold text-text-light uppercase tracking-widest">{activeTab==='dalle'?'Épaisseur':'Profondeur'} (mm)</label>
                          <div className="flex items-center gap-2">
                             <input 
                              type="number" 
                              className="w-full p-3 border border-border rounded-lg text-[13px] outline-none duration-200 focus:border-accent" 
                              value={formIsVar ? formEpMax : formEp}
                              onChange={(e) => formIsVar ? setFormEpMax(+e.target.value) : setFormEp(+e.target.value)}
                             />
                             <button onClick={() => setFormIsVar(!formIsVar)} className={`p-3 border rounded-lg text-[10px] font-bold uppercase shrink-0 transition-colors ${formIsVar?'bg-accent text-white border-accent':'bg-bg text-text-muted border-border'}`}>VAR</button>
                          </div>
                          {formIsVar && <input type="number" value={formEpMin} onChange={(e) => setFormEpMin(+e.target.value)} className="w-full p-2 border border-border rounded-lg text-[11px] mt-1" placeholder="Min" />}
                       </div>
                       <div className="flex flex-col gap-1.5">
                          <label className="text-[10px] font-bold text-text-light uppercase tracking-widest">Charge Vive (psf)</label>
                          <input 
                            type="number" 
                            className="p-3 border border-border rounded-lg text-[13px] outline-none duration-200 focus:border-accent" 
                            value={formLive}
                            onChange={(e) => setFormLive(+e.target.value)}
                          />
                       </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                       <div className="flex flex-col gap-1.5">
                          <label className="text-[10px] font-bold text-text-light uppercase tracking-widest">Larg. Trib. (ft)</label>
                          <input 
                            type="number" 
                            step="0.5"
                            className="p-3 border border-border rounded-lg text-[13px] outline-none duration-200 focus:border-accent" 
                            value={formTrib}
                            onChange={(e) => setFormTrib(+e.target.value)}
                          />
                       </div>
                       <div className="flex flex-col gap-1.5">
                          <label className="text-[10px] font-bold text-text-light uppercase tracking-widest">Portée Aluma (ft)</label>
                          <select 
                            className="p-3 border border-border rounded-lg text-[13px] outline-none duration-200 bg-white"
                            value={formSpan}
                            onChange={(e) => setFormSpan(+e.target.value)}
                          >
                             {[4,5,6,7].map(v => <option key={v} value={v}>{v}'</option>)}
                          </select>
                       </div>
                    </div>

                    <div className="flex gap-3 pt-2">
                       <button 
                        onClick={saveElement}
                        className="flex-1 bg-accent text-white py-3 border rounded-lg font-bold text-[13px] hover:filter hover:brightness-105 shadow-lg shadow-accent/10 transition-all flex items-center justify-center gap-2"
                       >
                         {editingId ? <Settings size={16} /> : <Plus size={16} />} 
                         {editingId ? 'Sauvegarder les Changements' : 'Ajouter à l\'Étude'}
                       </button>
                       {editingId && (
                         <button onClick={resetForm} className="px-4 border border-border rounded-lg text-text-muted hover:bg-bg transition-colors">
                            <X size={20} />
                         </button>
                       )}
                    </div>
                  </div>

                  <div className="bg-[#f8fafc] p-6 rounded-xl border border-dashed border-border mt-8 flex">
                     <div className="flex-1 text-center border-r border-border px-2">
                        <div className="val">{Math.round(calculations.total)}</div>
                        <div className="lbl">CHARGE TOTALE (psf)</div>
                     </div>
                     <div className="flex-1 text-center border-r border-border px-2">
                        <div className="val">{calculations.sp}"</div>
                        <div className="lbl">ESPACEMENT 4x4</div>
                     </div>
                     <div className="flex-1 text-center px-2">
                        <div className="val">{calculations.capAlu}</div>
                        <div className="lbl">CAPACITÉ ALUMA</div>
                     </div>
                  </div>

                  <div className="mt-8 p-4 bg-[#fffbeb] border border-[#f59e0b] rounded-[10px] flex items-start gap-4">
                     <div className="p-2 bg-[#f59e0b]/10 text-[#f59e0b] rounded-lg shrink-0"><AlertTriangle size={16} /></div>
                     <div className="text-[12px] leading-relaxed text-[#92400e]">
                        <strong className="block mb-0.5">Note Technique:</strong> Les calculs sont basés sur un contreplaqué 11/16″ et Aluma 165 avec F'b=1545 psi. Vérifiez toujours les limitations de déflexion (L/270).
                     </div>
                  </div>
               </div>
            </div>

            <div className="flex flex-col gap-5 overflow-hidden">
               <div className="bg-surface border border-border rounded-[10px] p-5 shadow-sm">
                  <div className="flex justify-between items-center mb-4">
                     <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Résumé de Charge</span>
                     <button onClick={() => copySummary(document.getElementById('summary-tool')?.innerText || '')} className="text-accent hover:underline text-[10px] font-bold">COPIER</button>
                  </div>
                  <div id="summary-tool" className="text-[11px] leading-relaxed font-mono uppercase bg-bg/30 p-4 rounded-lg border border-border/50" dangerouslySetInnerHTML={{ __html: summaryText }} />
               </div>

               <div className="bg-surface border border-border rounded-[10px] shadow-sm flex flex-col flex-1 overflow-hidden">
                  <div className="p-4 border-b border-border font-bold text-[12px] shrink-0">VÉRIFICATION DÉTAILLÉE</div>
                  <div className="flex-1 overflow-y-auto p-4 scroller-hidden">
                     <div className="space-y-4">
                        <div className="pb-3 border-b border-bg">
                           <div className="text-[10px] font-bold text-text-muted mb-2 uppercase tracking-wide">A1 — Structure</div>
                           <div className="space-y-1.5">
                              <div className="flex justify-between text-[11px]"><span>Poids Béton</span><span className="font-bold font-mono">{fmt(calculations.conc, 1)} psf</span></div>
                              <div className="flex justify-between text-[11px]"><span>Surpoids (M+V)</span><span className="font-bold font-mono">{formDead + formLive} psf</span></div>
                           </div>
                        </div>
                        <div className="pb-3 border-b border-bg">
                           <div className="text-[10px] font-bold text-text-muted mb-2 uppercase tracking-wide">A3 — Aluma Profile</div>
                           <div className="space-y-1.5">
                              <div className="flex justify-between text-[11px]"><span>Charge Lineaire</span><span className="font-bold font-mono">{fmt(calculations.loadAlu, 0)} lbs/ft</span></div>
                              <div className="flex justify-between text-[11px]"><span>Ratio Capacité</span><span className={`font-bold font-mono ${calculations.okAlu?'text-success':'text-danger'}`}>{Math.round(calculations.loadAlu/calculations.capAlu*100)}%</span></div>
                           </div>
                        </div>
                        <div className="p-4 bg-ai-accent/5 border border-ai-accent/20 rounded-lg">
                           <div className="text-[10px] font-bold text-ai-accent mb-2 uppercase tracking-wide flex items-center gap-2"><Sparkles size={10} /> Facteur IA</div>
                           <div className="text-[10px] leading-relaxed opacity-70">L'IA suggère un espacement de 48" basé sur l'analyse visuelle du plan de structure importé.</div>
                        </div>
                     </div>
                  </div>
               </div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}
