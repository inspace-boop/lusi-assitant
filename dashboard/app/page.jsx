'use client';

import { useState, useRef, useEffect } from 'react';
import { Send, Rocket } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './page.module.css';

export default function Home() {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Hello! I am the LUSI Rover AI. I can help you search the URC rules, check Confluence docs, find Jira issues, or recall past rover problems. What do you need?' }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = { role: 'user', content: input };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      // Note: Full conversation history should be passed to maintain context.
      const conversationHistory = [...messages, userMessage];
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: conversationHistory }),
      });

      if (!res.ok) throw new Error('API Error');

      const data = await res.json();
      
      setMessages(prev => [...prev, { role: 'assistant', content: data.message }]);
      
    } catch (error) {
      console.error(error);
      setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I encountered an error. Please try again.' }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveMemory = async () => {
    if (messages.length < 2) return;
    setIsLoading(true);
    try {
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages })
      });
      const data = await res.json();
      if (data.success) {
        alert("Session memory saved to Pinecone!");
      } else if (data.skipped) {
        alert("No clear technical problem/solution identified to save.");
      }
    } catch(e) {
      alert("Failed to save memory.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div style={{display: 'flex', alignItems: 'center'}}>
          <Rocket color="var(--primary)" size={24} />
          <h1 className={styles.title}>LUSI Rover Assistant</h1>
        </div>
        <button onClick={handleSaveMemory} className={styles.saveButton} disabled={isLoading || messages.length < 2}>
           Store Memory
        </button>
      </header>

      <main className={styles.chatArea}>
        {messages.map((msg, index) => (
          <div key={index} className={`${styles.messageWrapper} ${styles[msg.role]}`}>
            <div className={`${styles.message} ${styles[msg.role]}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {msg.content}
              </ReactMarkdown>
            </div>
          </div>
        ))}
        
        {isLoading && (
          <div className={`${styles.messageWrapper} assistant`}>
            <div className={`${styles.message} assistant`}>
              <div className={styles.loader}>
                <div className={styles.dot}></div>
                <div className={styles.dot}></div>
                <div className={styles.dot}></div>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </main>

      <div className={styles.inputArea}>
        <form className={styles.form} onSubmit={handleSubmit}>
          <input
            className={styles.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about URC rules, subsystems, or Jira tasks..."
            disabled={isLoading}
          />
          <button 
            type="submit" 
            className={styles.sendButton}
            disabled={!input.trim() || isLoading}
          >
            <Send size={20} />
          </button>
        </form>
      </div>
    </div>
  );
}
