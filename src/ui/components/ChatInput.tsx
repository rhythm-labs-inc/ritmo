import React, {useRef, useState} from 'react'

interface ChatInputProps {
  onSubmit: (message: string) => void
  disabled: boolean
}

export function ChatInput({onSubmit, disabled}: ChatInputProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSubmit(trimmed)
    setValue('')
    textareaRef.current?.focus()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  return (
    <form className="chat-input-form" onSubmit={handleSubmit}>
      <textarea
        ref={textareaRef}
        className="chat-input-textarea"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? 'Simulation running…' : 'Send a message (Enter to send, Shift+Enter for new line)'}
        disabled={disabled}
        rows={3}
      />
      <button
        type="submit"
        className="chat-input-submit"
        disabled={disabled || value.trim().length === 0}
      >
        {disabled ? 'Running…' : 'Send'}
      </button>
    </form>
  )
}
