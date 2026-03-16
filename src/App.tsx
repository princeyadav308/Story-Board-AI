import { useState, useEffect } from 'react';
import { GoogleGenAI, Type, Modality } from '@google/genai';
import { Image as ImageIcon, MessageSquare, Settings, Loader2, Play, AlertCircle, FileText, Download, RefreshCw, Copy, Check, Wand2, X, Film, Clapperboard } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { Scene, ChatMessage, ImageSize } from './types';

declare global {
  interface Window {
    aistudio?: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

export default function App() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [activeTab, setActiveTab] = useState<'script' | 'chat'>('script');
  
  // Script & Storyboard State
  const [script, setScript] = useState('');
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [imageSize, setImageSize] = useState<ImageSize>('1K');
  
  // Chat State
  const [chatInput, setChatInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isChatting, setIsChatting] = useState(false);

  // Export State
  const [isExporting, setIsExporting] = useState(false);
  const [isCopying, setIsCopying] = useState(false);

  // Edit State
  const [editingSceneId, setEditingSceneId] = useState<string | null>(null);
  const [editPrompt, setEditPrompt] = useState('');
  const [isApplyingEdit, setIsApplyingEdit] = useState(false);

  // Video Overview State
  const [overviewState, setOverviewState] = useState<{
    isOpen: boolean;
    status: 'idle' | 'enhancing' | 'video' | 'audio' | 'completed' | 'error';
    videoUrl: string | null;
    audioUrl: string | null;
    error: string | null;
  }>({
    isOpen: false,
    status: 'idle',
    videoUrl: null,
    audioUrl: null,
    error: null
  });

  useEffect(() => {
    if (window.aistudio) {
      window.aistudio.hasSelectedApiKey().then(setHasKey);
    } else {
      setHasKey(true);
    }
  }, []);

  const handleSelectKey = async () => {
    if (window.aistudio) {
      await window.aistudio.openSelectKey();
      setHasKey(true);
    }
  };

  const getAiInstance = () => {
    const apiKey = (process.env as any).API_KEY || (process.env as any).GEMINI_API_KEY;
    return new GoogleGenAI({ apiKey });
  };

  const handleDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('text/')) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setScript(event.target.result as string);
        }
      };
      reader.readAsText(file);
    }
  };

  const handleGenerateStoryboard = async () => {
    if (!script.trim()) return;
    
    setIsExtracting(true);
    setScenes([]);
    setActiveTab('script');
    
    try {
      const ai = getAiInstance();
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: `Analyze the following script and break it down into key visual scenes for a storyboard. 
        For each scene, provide a short description and a highly detailed image generation prompt.
        
        Script:
        ${script}`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                description: { type: Type.STRING, description: "Brief description of the scene's action" },
                prompt: { type: Type.STRING, description: "Detailed visual prompt for an image generator (lighting, camera angle, subject, environment)" }
              },
              required: ["id", "description", "prompt"]
            }
          }
        }
      });
      
      const text = response.text;
      if (text) {
        const parsedScenes = JSON.parse(text) as Scene[];
        const initializedScenes = parsedScenes.map(s => ({ ...s, status: 'pending' as const }));
        setScenes(initializedScenes);
        generateImagesForScenes(initializedScenes);
      }
    } catch (error) {
      console.error("Failed to extract scenes:", error);
    } finally {
      setIsExtracting(false);
    }
  };

  const generateImagesForScenes = async (scenesToProcess: Scene[]) => {
    const ai = getAiInstance();
    
    for (let i = 0; i < scenesToProcess.length; i++) {
      const scene = scenesToProcess[i];
      
      setScenes(prev => prev.map(s => s.id === scene.id ? { ...s, status: 'generating' } : s));
      
      try {
        const response = await ai.models.generateContent({
          model: 'gemini-3-pro-image-preview',
          contents: scene.prompt,
          config: {
            imageConfig: {
              aspectRatio: "16:9",
              imageSize: imageSize
            }
          }
        });
        
        let imageUrl = '';
        const parts = response.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.inlineData) {
            imageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            break;
          }
        }
        
        if (imageUrl) {
          setScenes(prev => prev.map(s => s.id === scene.id ? { ...s, status: 'completed', imageUrl } : s));
        } else {
          throw new Error("No image data returned");
        }
      } catch (error) {
        console.error(`Failed to generate image for scene ${scene.id}:`, error);
        setScenes(prev => prev.map(s => s.id === scene.id ? { ...s, status: 'error', error: String(error) } : s));
      }
    }
  };

  const handleReimagineScene = (sceneId: string) => {
    const sceneToReimagine = scenes.find(s => s.id === sceneId);
    if (sceneToReimagine) {
      generateImagesForScenes([sceneToReimagine]);
    }
  };

  const handleSendMessage = async () => {
    if (!chatInput.trim()) return;
    
    const newUserMsg: ChatMessage = { id: Date.now().toString(), role: 'user', text: chatInput };
    setMessages(prev => [...prev, newUserMsg]);
    setChatInput('');
    setIsChatting(true);
    
    try {
      const ai = getAiInstance();
      
      const contents: any[] = messages.map(m => ({
        role: m.role,
        parts: [{ text: m.text }]
      }));
      
      contents.push({
        role: 'user',
        parts: [{ text: chatInput }]
      });
      
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: contents,
        config: {
          systemInstruction: `You are a helpful AI assistant for a storyboard creation app. The user's current script is:\n\n${script}\n\nHelp them refine it, brainstorm visual ideas, or answer questions.`,
        }
      });
      
      const newModelMsg: ChatMessage = { id: (Date.now() + 1).toString(), role: 'model', text: response.text || '' };
      setMessages(prev => [...prev, newModelMsg]);
    } catch (error) {
      console.error("Chat error:", error);
      const errorMsg: ChatMessage = { id: (Date.now() + 1).toString(), role: 'model', text: "Sorry, I encountered an error processing your request." };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsChatting(false);
    }
  };

  const handleFileUploadClick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'text/plain,.md,.fountain';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          if (event.target?.result) {
            setScript(event.target.result as string);
          }
        };
        reader.readAsText(file);
      }
    };
    input.click();
  };

  const handleCopyToKling = async () => {
    const completedScenes = scenes.filter(s => s.status === 'completed' && s.imageUrl);
    if (completedScenes.length === 0) return;

    try {
      let htmlContent = '<div>';
      let textContent = '';

      completedScenes.forEach((scene, index) => {
        const sceneNum = String(index + 1).padStart(2, '0');
        
        htmlContent += `<h3>Scene ${sceneNum}</h3>`;
        htmlContent += `<p><strong>Description:</strong> ${scene.description}</p>`;
        htmlContent += `<p><strong>Prompt:</strong> ${scene.prompt}</p>`;
        htmlContent += `<img src="${scene.imageUrl}" alt="Scene ${sceneNum}" style="max-width: 100%; height: auto;" /><br/><br/>`;

        textContent += `Scene ${sceneNum}\n`;
        textContent += `Description: ${scene.description}\n`;
        textContent += `Prompt: ${scene.prompt}\n\n`;
      });

      htmlContent += '</div>';

      try {
        const clipboardItem = new ClipboardItem({
          'text/html': new Blob([htmlContent], { type: 'text/html' }),
          'text/plain': new Blob([textContent], { type: 'text/plain' })
        });
        await navigator.clipboard.write([clipboardItem]);
      } catch (err) {
        console.warn("Rich text copy failed, falling back to plain text", err);
        await navigator.clipboard.writeText(textContent);
      }
      
      setIsCopying(true);
      setTimeout(() => setIsCopying(false), 2000);
    } catch (error) {
      console.error("Copy failed:", error);
    }
  };

  const handleApplyEdit = async () => {
    if (!editingSceneId || !editPrompt.trim()) return;
    const scene = scenes.find(s => s.id === editingSceneId);
    if (!scene || !scene.imageUrl) return;

    setIsApplyingEdit(true);
    try {
      const ai = getAiInstance();
      const base64Data = scene.imageUrl.split(',')[1];
      const mimeType = scene.imageUrl.split(';')[0].split(':')[1];

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType: mimeType,
              },
            },
            {
              text: editPrompt,
            },
          ],
        },
      });

      let newImageUrl = '';
      const parts = response.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData) {
          newImageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          break;
        }
      }

      if (newImageUrl) {
        setScenes(prev => prev.map(s => s.id === editingSceneId ? { ...s, imageUrl: newImageUrl } : s));
        setEditingSceneId(null);
        setEditPrompt('');
      } else {
        throw new Error("No image data returned from edit");
      }
    } catch (error) {
      console.error("Failed to edit image:", error);
      alert("Failed to edit image. Please try again.");
    } finally {
      setIsApplyingEdit(false);
    }
  };

  const handleGenerateVideoOverview = async () => {
    const completedScenes = scenes.filter(s => s.status === 'completed' && s.imageUrl);
    if (completedScenes.length === 0) return;
    
    setOverviewState({
      isOpen: true,
      status: 'video',
      videoUrl: null,
      audioUrl: null,
      error: null
    });

    try {
      const ai = getAiInstance();
      
      const getInlineData = (scene: Scene) => {
        if (!scene.imageUrl) throw new Error("No image URL");
        const base64Data = scene.imageUrl.split(',')[1];
        const mimeType = scene.imageUrl.split(';')[0].split(':')[1];
        return { imageBytes: base64Data, mimeType };
      };

      const firstScene = completedScenes[0];
      const firstImageData = getInlineData(firstScene);

      let operation = await ai.models.generateVideos({
        model: 'veo-3.1-fast-generate-preview',
        prompt: 'Cinematic transition, smooth motion, highly detailed, masterpiece',
        image: firstImageData,
        config: {
          numberOfVideos: 1,
          resolution: '720p',
          aspectRatio: '16:9'
        }
      });

      while (!operation.done) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        operation = await ai.operations.getVideosOperation({operation: operation});
      }

      const videoUri = operation.response?.generatedVideos?.[0]?.video?.uri;
      if (!videoUri) throw new Error("Video generation failed to return a URI");

      // Fetch video
      let apiKey = '';
      try { apiKey = (process as any).env.API_KEY; } catch (e) {}
      if (!apiKey) {
        try { apiKey = (import.meta as any).env.VITE_GEMINI_API_KEY; } catch (e) {}
      }
      if (!apiKey) {
        apiKey = (ai as any).apiKey || '';
      }

      const videoResponse = await fetch(videoUri, {
        method: 'GET',
        headers: {
          'x-goog-api-key': apiKey,
        },
      });
      const videoBlob = await videoResponse.blob();
      const videoObjectUrl = URL.createObjectURL(videoBlob);
      
      setOverviewState(prev => ({ ...prev, status: 'audio', videoUrl: videoObjectUrl }));

      // Generate Audio
      const summaryPrompt = `Generate a dramatic, cinematic voiceover narration for this script. Keep it under 30 seconds. Script: ${script.substring(0, 1000)}`;
      const audioRes = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: summaryPrompt }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Zephyr' },
            },
          },
        },
      });

      const base64Audio = audioRes.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      let audioObjectUrl = null;
      if (base64Audio) {
        audioObjectUrl = `data:audio/wav;base64,${base64Audio}`;
      }

      setOverviewState(prev => ({ 
        ...prev, 
        status: 'completed',
        audioUrl: audioObjectUrl
      }));

    } catch (error: any) {
      console.error("Video overview generation failed:", error);
      setOverviewState(prev => ({ 
        ...prev, 
        status: 'error',
        error: error.message || "An error occurred"
      }));
    }
  };

  const handleExport = async () => {
    const completedScenes = scenes.filter(s => s.status === 'completed' && s.imageUrl);
    if (completedScenes.length === 0) return;

    setIsExporting(true);
    try {
      const zip = new JSZip();
      let markdown = `# Storyboard\n\n`;

      completedScenes.forEach((scene, index) => {
        const sceneNum = String(index + 1).padStart(2, '0');
        const filename = `scene_${sceneNum}.png`;

        // Extract base64 data
        const base64Data = scene.imageUrl!.split(',')[1];
        zip.file(filename, base64Data, { base64: true });

        markdown += `## Scene ${sceneNum}\n`;
        markdown += `**Description:** ${scene.description}\n\n`;
        markdown += `**Prompt:** ${scene.prompt}\n\n`;
        markdown += `![Scene ${sceneNum}](${filename})\n\n`;
      });

      zip.file('storyboard.md', markdown);

      const content = await zip.generateAsync({ type: 'blob' });
      saveAs(content, 'storyboard.zip');
    } catch (error) {
      console.error("Export failed:", error);
    } finally {
      setIsExporting(false);
    }
  };

  if (hasKey === false) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4 font-sans">
        <div className="max-w-md w-full bg-zinc-900 border border-zinc-800 rounded-2xl p-8 flex flex-col items-center text-center gap-6">
          <div className="w-16 h-16 bg-zinc-800 rounded-full flex items-center justify-center">
            <Settings className="w-8 h-8 text-zinc-400" />
          </div>
          <div>
            <h2 className="text-xl font-display font-medium text-zinc-100 mb-2">API Key Required</h2>
            <p className="text-sm text-zinc-400 leading-relaxed">
              This app uses premium Gemini models for high-quality image generation. 
              Please select your API key to continue.
            </p>
          </div>
          <button 
            onClick={handleSelectKey}
            className="w-full bg-zinc-100 text-zinc-950 font-medium py-3 rounded-xl hover:bg-white transition-colors"
          >
            Select API Key
          </button>
        </div>
      </div>
    );
  }

  if (hasKey === null) {
    return <div className="min-h-screen bg-zinc-950 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-zinc-500" /></div>;
  }

  return (
    <div className="h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans overflow-hidden">
      <header className="h-14 border-b border-zinc-800 flex items-center justify-between px-6 shrink-0 bg-zinc-950 z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-600 text-white rounded-lg flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Clapperboard className="w-4 h-4" />
          </div>
          <h1 className="font-display font-semibold tracking-tight text-base">Storyboard AI</h1>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={handleGenerateVideoOverview}
            disabled={scenes.filter(s => s.status === 'completed').length === 0 || (overviewState.status !== 'idle' && overviewState.status !== 'completed' && overviewState.status !== 'error')}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Film className="w-4 h-4" />
            Generate Intro Video
          </button>
          <button
            onClick={handleCopyToKling}
            disabled={scenes.filter(s => s.status === 'completed').length === 0}
            className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCopying ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
            {isCopying ? 'Copied!' : 'Copy to Kling'}
          </button>
          <button
            onClick={handleExport}
            disabled={isExporting || scenes.filter(s => s.status === 'completed').length === 0}
            className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Export ZIP
          </button>
          <div className="flex items-center gap-2 text-xs font-medium text-zinc-400">
            <span>RESOLUTION</span>
            <select 
              value={imageSize} 
              onChange={(e) => setImageSize(e.target.value as ImageSize)}
              className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 outline-none focus:border-zinc-600 text-zinc-100"
            >
              <option value="1K">1K</option>
              <option value="2K">2K</option>
              <option value="4K">4K</option>
            </select>
          </div>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        <div className="w-1/3 min-w-[320px] max-w-[480px] border-r border-zinc-800 flex flex-col bg-zinc-900/30 z-10">
          <div className="flex border-b border-zinc-800 shrink-0">
            <button 
              onClick={() => setActiveTab('script')}
              className={`flex-1 py-3 text-xs font-medium tracking-wider uppercase border-b-2 transition-colors ${activeTab === 'script' ? 'border-zinc-100 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}
            >
              Script
            </button>
            <button 
              onClick={() => setActiveTab('chat')}
              className={`flex-1 py-3 text-xs font-medium tracking-wider uppercase border-b-2 transition-colors ${activeTab === 'chat' ? 'border-zinc-100 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}
            >
              AI Assistant
            </button>
          </div>

          <div className="flex-1 overflow-hidden relative">
            {activeTab === 'script' ? (
              <div className="absolute inset-0 flex flex-col p-4 gap-4">
                <div className="flex-1 flex flex-col gap-2 min-h-0">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Source Material</label>
                    <button onClick={handleFileUploadClick} className="text-xs text-zinc-400 hover:text-zinc-100 flex items-center gap-1">
                      <FileText className="w-3 h-3" /> Upload File
                    </button>
                  </div>
                  <textarea 
                    value={script}
                    onChange={(e) => setScript(e.target.value)}
                    placeholder="Paste your script here, or drag and drop a text file..."
                    className="flex-1 bg-zinc-900/50 border border-zinc-800 rounded-lg p-3 text-sm resize-none outline-none focus:border-zinc-600 transition-colors font-mono leading-relaxed"
                    onDrop={handleDrop}
                    onDragOver={(e) => e.preventDefault()}
                  />
                </div>
                <button 
                  onClick={handleGenerateStoryboard}
                  disabled={!script.trim() || isExtracting}
                  className="w-full bg-zinc-100 text-zinc-950 font-medium py-3 rounded-lg flex items-center justify-center gap-2 hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
                >
                  {isExtracting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
                  Generate Storyboard
                </button>
              </div>
            ) : (
              <div className="absolute inset-0 flex flex-col p-4">
                <div className="flex-1 overflow-y-auto flex flex-col gap-4 pb-4 min-h-0">
                  {messages.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center text-zinc-500 gap-3 px-4">
                      <MessageSquare className="w-8 h-8 opacity-20" />
                      <p className="text-sm">Ask questions about your script or request ideas for scenes.</p>
                    </div>
                  ) : (
                    messages.map(msg => (
                      <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                        <div className={`max-w-[90%] rounded-lg px-4 py-3 text-sm ${msg.role === 'user' ? 'bg-zinc-800 text-zinc-100' : 'bg-zinc-900 border border-zinc-800 text-zinc-300'}`}>
                          <div className="markdown-body">
                            <ReactMarkdown>{msg.text}</ReactMarkdown>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                  {isChatting && (
                    <div className="flex items-start">
                      <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm text-zinc-500 flex items-center gap-2">
                        <Loader2 className="w-3 h-3 animate-spin" /> Thinking...
                      </div>
                    </div>
                  )}
                </div>
                <div className="pt-3 shrink-0">
                  <div className="relative">
                    <input 
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                      placeholder="Message AI..."
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-4 pr-10 py-3 text-sm outline-none focus:border-zinc-600 transition-colors"
                    />
                    <button 
                      onClick={handleSendMessage}
                      disabled={!chatInput.trim() || isChatting}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
                    >
                      <MessageSquare className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-8 bg-[#050505]">
          {scenes.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-zinc-600 gap-4">
              <ImageIcon className="w-16 h-16 opacity-10" />
              <p className="text-sm font-medium tracking-wide">NO STORYBOARD GENERATED</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-8 pb-12">
              {scenes.map((scene, index) => {
                let lastSuccessUrl = null;
                if (scene.status === 'error') {
                  for (let i = index - 1; i >= 0; i--) {
                    if (scenes[i].status === 'completed' && scenes[i].imageUrl) {
                      lastSuccessUrl = scenes[i].imageUrl;
                      break;
                    }
                  }
                }

                return (
                  <div key={scene.id} className="bg-[#0a0a0a] border border-zinc-800/50 rounded-xl overflow-hidden flex flex-col shadow-2xl">
                    <div className="aspect-video bg-zinc-900/50 relative flex items-center justify-center overflow-hidden">
                      {scene.status === 'completed' && scene.imageUrl ? (
                        <img src={scene.imageUrl} alt={scene.description} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                      ) : scene.status === 'error' ? (
                        <div className="relative w-full h-full flex items-center justify-center">
                          {lastSuccessUrl && (
                            <img src={lastSuccessUrl} alt="Previous scene fallback" className="absolute inset-0 w-full h-full object-cover opacity-20 grayscale blur-sm" referrerPolicy="no-referrer" />
                          )}
                          <div className={`relative z-10 flex flex-col items-center gap-2 text-red-400/80 ${lastSuccessUrl ? 'bg-zinc-900/80 p-3 rounded-lg backdrop-blur-md border border-red-500/20' : ''}`}>
                            <AlertCircle className="w-6 h-6" />
                            <span className="text-xs font-mono">GENERATION FAILED</span>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-4 text-zinc-500">
                          <Loader2 className="w-6 h-6 animate-spin" />
                          <span className="text-[10px] font-mono tracking-widest text-zinc-400">
                            {scene.status === 'generating' ? 'RENDERING FRAME...' : 'QUEUED...'}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="p-5 flex flex-col gap-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-mono tracking-widest text-zinc-500">SCENE {String(index + 1).padStart(2, '0')}</span>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => { setEditingSceneId(scene.id); setEditPrompt(''); }}
                            disabled={scene.status !== 'completed'}
                            className="text-zinc-500 hover:text-zinc-100 transition-colors disabled:opacity-50"
                            title="AI Magic Edit"
                          >
                            <Wand2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleReimagineScene(scene.id)}
                            disabled={scene.status === 'generating' || scene.status === 'pending'}
                            className="text-zinc-500 hover:text-zinc-100 transition-colors disabled:opacity-50"
                            title="Reimagine Scene"
                          >
                            <RefreshCw className={`w-3.5 h-3.5 ${scene.status === 'generating' ? 'animate-spin' : ''}`} />
                          </button>
                        </div>
                      </div>
                      <p className="text-sm text-zinc-200 leading-relaxed font-medium">{scene.description}</p>
                      <p className="text-xs text-zinc-500 mt-1 line-clamp-3 font-mono leading-relaxed" title={scene.prompt}>{scene.prompt}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>

      {editingSceneId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-2xl overflow-hidden flex flex-col shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b border-zinc-800">
              <h3 className="text-sm font-display font-medium text-zinc-100 flex items-center gap-2">
                <Wand2 className="w-4 h-4" /> AI Magic Edit
              </h3>
              <button onClick={() => setEditingSceneId(null)} className="text-zinc-500 hover:text-zinc-100 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 flex flex-col gap-4">
              <div className="aspect-video bg-black rounded-lg overflow-hidden flex items-center justify-center border border-zinc-800/50">
                <img src={scenes.find(s => s.id === editingSceneId)?.imageUrl} alt="Editing" className="max-w-full max-h-full object-contain" />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Edit Instructions</label>
                <input
                  type="text"
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  placeholder="e.g., Make it cinematic, add a red car, change the lighting to sunset..."
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-zinc-600 text-zinc-100 transition-colors"
                  onKeyDown={(e) => e.key === 'Enter' && handleApplyEdit()}
                  autoFocus
                />
              </div>
            </div>
            <div className="p-4 border-t border-zinc-800 flex justify-end gap-3 bg-zinc-950/50">
              <button
                onClick={() => setEditingSceneId(null)}
                className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleApplyEdit}
                disabled={!editPrompt.trim() || isApplyingEdit}
                className="px-4 py-2 bg-zinc-100 text-zinc-950 text-sm font-medium rounded-lg hover:bg-white transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {isApplyingEdit ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                Apply Edit
              </button>
            </div>
          </div>
        </div>
      )}

      {overviewState.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-4xl overflow-hidden flex flex-col shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b border-zinc-800">
              <h3 className="text-sm font-display font-medium text-zinc-100 flex items-center gap-2">
                <Film className="w-4 h-4" /> Generate Intro Video
              </h3>
              <button onClick={() => setOverviewState(prev => ({ ...prev, isOpen: false }))} className="text-zinc-500 hover:text-zinc-100 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-8 flex flex-col items-center justify-center min-h-[400px] gap-6">
              {overviewState.status === 'enhancing' && (
                <div className="flex flex-col items-center gap-4 text-zinc-400">
                  <Wand2 className="w-8 h-8 animate-pulse text-indigo-400" />
                  <p className="font-mono text-sm tracking-widest uppercase">Enhancing images with Nano Banana 2...</p>
                </div>
              )}
              {overviewState.status === 'video' && (
                <div className="flex flex-col items-center gap-4 text-zinc-400">
                  <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
                  <p className="font-mono text-sm tracking-widest uppercase">Generating video with Veo (this takes a few minutes)...</p>
                </div>
              )}
              {overviewState.status === 'audio' && (
                <div className="flex flex-col items-center gap-4 text-zinc-400">
                  <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
                  <p className="font-mono text-sm tracking-widest uppercase">Generating dramatic voiceover...</p>
                </div>
              )}
              {overviewState.status === 'error' && (
                <div className="flex flex-col items-center gap-4 text-red-400">
                  <AlertCircle className="w-8 h-8" />
                  <p className="font-mono text-sm tracking-widest uppercase">Generation Failed</p>
                  <p className="text-xs text-zinc-500 text-center max-w-md">{overviewState.error}</p>
                  <button 
                    onClick={handleGenerateVideoOverview}
                    className="mt-4 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded text-sm transition-colors"
                  >
                    Try Again
                  </button>
                </div>
              )}
              {overviewState.status === 'completed' && overviewState.videoUrl && (
                <div className="w-full flex flex-col items-center gap-4">
                  <video 
                    src={overviewState.videoUrl} 
                    controls 
                    autoPlay 
                    loop 
                    className="w-full max-w-3xl rounded-lg shadow-lg border border-zinc-800"
                  />
                  {overviewState.audioUrl && (
                    <audio src={overviewState.audioUrl} controls autoPlay loop className="w-full max-w-3xl mt-4" />
                  )}
                  <p className="text-xs text-zinc-500 font-mono text-center">Video and Audio generated successfully.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
