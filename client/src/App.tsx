import React, { useState, useEffect, useRef, type ChangeEvent, type DragEvent } from 'react';
import './App.css';

const API_BASE = "http://127.0.0.1:5000";

// --- Types ---
interface Paper { id: string; name: string; size: number; b64: string; }
interface MessageGroup { id: number; question: string; answers: string[]; }
interface ProgressItem { id: string; name: string; status: 'reading…' | '✓'; progress: number; }
type Source = 'uploads' | 's3' | 'both';

// --- Utility Functions ---
const formatBytes = (b: number) => {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
};

const truncate = (str: string, len: number) => (str.length > len ? str.slice(0, len) + '…' : str);

const formatMarkdown = (text: string) => {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^/, '<p>').replace(/$/, '</p>')
    .replace(/<p><\/p>/g, '');
};

export default function App() {
  // --- State ---
  const [health, setHealth] = useState({ status: 'checking...', className: '' });
  const [uploadedPapers, setUploadedPapers] = useState<Paper[]>([]);
  const [activeSource, setActiveSource] = useState<Source>('uploads');
  const [uploadProgress, setUploadProgress] = useState<ProgressItem[]>([]);
  const [messages, setMessages] = useState<MessageGroup[]>([]);
  const [questionInput, setQuestionInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [notification, setNotification] = useState({ show: false, msg: '', type: '' });
  const [msgCount, setMsgCount] = useState(0);

  // --- Refs ---
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // --- Initialization ---
  useEffect(() => {
    checkHealth();
  }, []);

  useEffect(() => {
    if (chatAreaRef.current) {
      chatAreaRef.current.scrollTop = chatAreaRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  const checkHealth = async () => {
    try {
      const r = await fetch(`${API_BASE}/health`);
      if (r.ok) {
        const d = await r.json();
        setHealth({ status: `online · ${d.source || 'ready'}`, className: 'online' });
      } else throw new Error();
    } catch {
      setHealth({ status: 'offline', className: 'error' });
    }
  };

  const showNotification = (msg: string, type: string = '') => {
    setNotification({ show: true, msg, type });
    setTimeout(() => setNotification((prev) => ({ ...prev, show: false })), 3000);
  };

  // --- Upload Handlers ---
  const onDragOver = (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setIsDragOver(true); };
  const onDragLeave = () => setIsDragOver(false);
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  };

  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(e.target.files);
  };

  const handleFiles = (files: FileList) => {
    const pdfs = Array.from(files).filter(f => f.type === 'application/pdf' || f.name.endsWith('.pdf'));
    if (!pdfs.length) {
      showNotification('Only PDF files are supported.', 'error');
      return;
    }
    pdfs.forEach(processPDF);
  };

  const processPDF = (file: File) => {
    const id = 'pdf_' + Date.now() + Math.random().toString(36).slice(2, 6);
    
    setUploadProgress(prev => [...prev, { id, name: file.name, status: 'reading…', progress: 80 }]);

    const reader = new FileReader();
    reader.onload = (e) => {
      const b64 = (e.target?.result as string).split(',')[1];
      const newPaper: Paper = { id, name: file.name, size: file.size, b64 };
      
      setUploadedPapers(prev => [...prev, newPaper]);
      setUploadProgress(prev => prev.map(p => p.id === id ? { ...p, status: '✓', progress: 100 } : p));
      showNotification(`"${truncate(file.name, 30)}" added`, 'success');

      setTimeout(() => {
        setUploadProgress(prev => prev.filter(p => p.id !== id));
      }, 1500);
    };
    
    reader.onerror = () => {
      showNotification(`Failed to read ${file.name}`, 'error');
      setUploadProgress(prev => prev.filter(p => p.id !== id));
    };
    reader.readAsDataURL(file);
  };

  const removePaper = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setUploadedPapers(prev => prev.filter(p => p.id !== id));
  };

  // --- Chat Handlers ---
  const autoResizeTextarea = () => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 180) + 'px';
  };

  const handleInput = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setQuestionInput(e.target.value);
    autoResizeTextarea();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendQuestion();
    }
  };

  const handleSuggestionClick = (text: string) => {
    setQuestionInput(text);
    if (textareaRef.current) {
      textareaRef.current.focus();
      setTimeout(autoResizeTextarea, 0);
    }
  };

  const sendQuestion = async () => {
    if (isLoading) return;
    const question = questionInput.trim();
    if (!question) return;

    if (activeSource === 'uploads' && !uploadedPapers.length) {
      showNotification('Upload at least one PDF first, or switch context source to S3.', 'error');
      return;
    }

    const currentMsgId = msgCount + 1;
    setMsgCount(currentMsgId);
    setMessages(prev => [...prev, { id: currentMsgId, question, answers: [] }]);
    
    setQuestionInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    setIsLoading(true);

    try {
      const payload: any = { question };
      if ((activeSource === 'uploads' || activeSource === 'both') && uploadedPapers.length) {
        payload.pdf_files = uploadedPapers.map(p => ({ name: p.name, data: p.b64 }));
      }
      if (activeSource === 's3' || activeSource === 'both') {
        payload.use_s3 = true;
      }

      const r = await fetch(`${API_BASE}/response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();

      const answerText = (!r.ok || data.error) 
        ? `Error: ${data.error || 'Something went wrong. Is the backend running?'}`
        : data.response;

      setMessages(prev => prev.map(msg => 
        msg.id === currentMsgId 
          ? { ...msg, answers: [...msg.answers, answerText] } 
          : msg
      ));
    } catch (err: any) {
      setMessages(prev => prev.map(msg => 
        msg.id === currentMsgId 
          ? { ...msg, answers: [...msg.answers, `Could not reach the server. Message: ${err.message}`] } 
          : msg
      ));
    } finally {
      setIsLoading(false);
    }
  };

  // --- Context Bar Derived Data ---
  const activeTags = [];
  if ((activeSource === 'uploads' || activeSource === 'both') && uploadedPapers.length > 0) {
    activeTags.push(`${uploadedPapers.length} PDF${uploadedPapers.length > 1 ? 's' : ''}`);
  }
  if (activeSource === 's3' || activeSource === 'both') {
    activeTags.push('S3 Bucket');
  }

  return (
    <>
      <div className="topbar">
        <div className="logo">
          <div className="logo-mark"></div>
          <span className="logo-text">Folio<span>.</span></span>
        </div>
        <div className="topbar-meta">Research Intelligence System</div>
        <div className="topbar-right">
          <span className={`status-dot ${health.className}`}>{health.status}</span>
        </div>
      </div>

      <div className="main">
        {/* LEFT PANEL */}
        <div className="panel-left">
          <div className="panel-header">
            <span className="panel-title">Papers</span>
            <span className="paper-count">{uploadedPapers.length}</span>
          </div>

          <div 
            className={`upload-zone ${isDragOver ? 'drag-over' : ''}`}
            onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
          >
            <input 
              type="file" 
              accept=".pdf" 
              multiple 
              ref={fileInputRef} 
              onChange={onFileInputChange} 
            />
            <svg className="upload-icon" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="8" y="4" width="18" height="24" rx="2" stroke="#c9a96e" strokeWidth="1.5"/>
              <path d="M22 4v8h8" stroke="#c9a96e" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M29 16 22 4" stroke="#c9a96e" strokeWidth="1.5"/>
              <circle cx="27" cy="30" r="8" fill="#0e0e0f" stroke="#c9a96e" strokeWidth="1.5"/>
              <path d="M27 26v8M23 30l4-4 4 4" stroke="#c9a96e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <div className="upload-title">Drop PDFs here</div>
            <div className="upload-sub">or click to browse</div>
          </div>

          {uploadProgress.length > 0 && (
            <div className="upload-progress visible">
              {uploadProgress.map(prog => (
                <div className="progress-item" key={prog.id}>
                  <span className="progress-name">{prog.name}</span>
                  <div className="progress-bar-wrap">
                    <div className="progress-bar" style={{ width: `${prog.progress}%` }}></div>
                  </div>
                  <span className="progress-status">{prog.status}</span>
                </div>
              ))}
            </div>
          )}

          <div className="paper-list">
            {uploadedPapers.length === 0 ? (
              <div className="no-papers">No papers added yet.<br/>Upload PDFs to begin analysis.</div>
            ) : (
              uploadedPapers.map(p => (
                <div className="paper-item" key={p.id}>
                  <div className="paper-icon">PDF</div>
                  <div className="paper-info">
                    <div className="paper-name" title={p.name}>{truncate(p.name.replace('.pdf',''), 28)}</div>
                    <div className="paper-meta">{formatBytes(p.size)}</div>
                  </div>
                  <button className="paper-remove" onClick={(e) => removePaper(p.id, e)} title="Remove">×</button>
                </div>
              ))
            )}
          </div>

          <div className="source-toggle">
            <div className="source-label">Context Source</div>
            <div className="toggle-group">
              {(['uploads', 's3', 'both'] as Source[]).map(src => (
                <button 
                  key={src}
                  className={`toggle-btn ${activeSource === src ? 'active' : ''}`} 
                  onClick={() => setActiveSource(src)}
                >
                  {src === 'uploads' ? 'Uploaded PDFs' : src === 's3' ? 'S3 Bucket' : 'Both'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT PANEL */}
        <div className="panel-right">
          <div className="chat-area" ref={chatAreaRef}>
            {messages.length === 0 ? (
              <div className="empty-state">
                <div className="empty-glyph">§</div>
                <div className="empty-title">Begin your inquiry</div>
                <div className="empty-sub">Upload research papers or connect to your S3 bucket, then ask anything about your documents.</div>
                <div className="suggestion-chips">
                  {['Summarize the main findings', 'What methodology was used?', 'Compare key arguments', 'What are the limitations?', 'Extract citations'].map(chip => (
                    <div key={chip} className="chip" onClick={() => handleSuggestionClick(chip)}>{chip}</div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="messages" style={{ display: 'flex' }}>
                {messages.map((msgGroup) => (
                  <div key={msgGroup.id}>
                    {msgGroup.id > 1 && (
                      <div className="msg-divider">
                        <span className="msg-divider-text">Query {msgGroup.id}</span>
                      </div>
                    )}
                    <div className="msg-group">
                      <div className="msg-user">
                        <div className="msg-user-label">Your question</div>
                        <div className="msg-user-text">{msgGroup.question}</div>
                      </div>
                      
                      {msgGroup.answers.map((ans, idx) => (
                        <div className="msg-assistant" key={idx}>
                          <div className="msg-assistant-header">
                            <div className="msg-assistant-icon">
                              <svg viewBox="0 0 14 14"><path d="M7 1l1.5 4H13l-3.5 2.5L11 12 7 9.5 3 12l1.5-4.5L1 5h4.5z"/></svg>
                            </div>
                            <span className="msg-assistant-label">Folio</span>
                          </div>
                          <div 
                            className="msg-assistant-body" 
                            dangerouslySetInnerHTML={{ __html: formatMarkdown(ans) }} 
                          />
                        </div>
                      ))}

                      {isLoading && msgGroup.id === msgCount && msgGroup.answers.length === 0 && (
                        <div className="typing-indicator">
                          <div className="msg-assistant-header">
                            <div className="msg-assistant-icon">
                              <svg viewBox="0 0 14 14"><path d="M7 1l1.5 4H13l-3.5 2.5L11 12 7 9.5 3 12l1.5-4.5L1 5h4.5z"/></svg>
                            </div>
                            <span className="msg-assistant-label">Folio</span>
                          </div>
                          <div className="typing-dots"><span></span><span></span><span></span></div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="input-area">
            <div className="input-context-bar">
              {activeTags.length === 0 ? (
                <span className="context-none">No context loaded</span>
              ) : (
                activeTags.map((tag, i) => (
                  <div className="context-tag" key={i}>
                    <span className="context-tag-dot"></span>{tag}
                  </div>
                ))
              )}
            </div>
            <div className="input-row">
              <div className="input-wrapper">
                <textarea
                  ref={textareaRef}
                  value={questionInput}
                  onChange={handleInput}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask a question about your papers…"
                  rows={1}
                ></textarea>
              </div>
              <button className="send-btn" onClick={sendQuestion} disabled={isLoading || !questionInput.trim()}>
                <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
                  <path d="M18 10L2 2l6 8-6 8L18 10z"/>
                </svg>
              </button>
            </div>
            <div className="input-footer">
              <span className="input-hint">⏎ send &nbsp;·&nbsp; Shift+⏎ newline</span>
              <span className="char-count">{questionInput.length}</span>
            </div>
          </div>
        </div>
      </div>

      <div className={`notification ${notification.type} ${notification.show ? 'show' : ''}`}>
        {notification.msg}
      </div>
    </>
  );
}