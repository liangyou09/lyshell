// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEscDismiss } from '@/hooks/useDismiss'
import RackCombobox from './RackCombobox'

afterEach(cleanup)

const props = {
  label: 'Model', optionsLabel: 'Choose a model', emptyText: 'Use your custom model',
  options: ['gpt-6', 'gpt-6-mini', 'claude-sonnet-5']
}

const Controlled = ({ close = () => {}, disabled = false }: { close?: () => void; disabled?: boolean }) => {
  const [value, setValue] = useState('')
  useEscDismiss(true, close)
  return <RackCombobox {...props} value={value} onChange={setValue} disabled={disabled} />
}

describe('可编辑模型候选列表', () => {
  it('展开列表渲染到 body，选择后更新模型并收起，输入框保留焦点', () => {
    const view = render(<Controlled />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose a model' }))
    const list = screen.getByRole('listbox')
    expect(list.parentElement).toBe(document.body)
    expect(view.container.contains(list)).toBe(false)
    fireEvent.click(screen.getByRole('option', { name: 'gpt-6-mini' }))
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('gpt-6-mini')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
  })

  it('按输入过滤，允许任意模型名和空值，不强制替换成候选', () => {
    render(<Controlled />)
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'GPT-6' } })
    expect(screen.getAllByRole('option')).toHaveLength(2)
    fireEvent.change(input, { target: { value: 'private-model-v2' } })
    expect(screen.getByRole('status').textContent).toBe('Use your custom model')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect((input as HTMLInputElement).value).toBe('private-model-v2')
    fireEvent.change(input, { target: { value: '' } })
    expect((input as HTMLInputElement).value).toBe('')
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  it('支持上下键与 Enter，IME 组合中 Enter 不误选', () => {
    render(<Controlled />)
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[2].id)
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect((input as HTMLInputElement).value).toBe('')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect((input as HTMLInputElement).value).toBe('gpt-6')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('第一次 Escape 只收模型菜单，第二次才交给编辑器，Tab 和外点也收菜单', () => {
    const close = vi.fn()
    render(<Controlled close={close} />)
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(close).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('键盘选中超出菜单可视区的候选时，仅调整菜单自身滚动', () => {
    render(<Controlled />)
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const menu = screen.getByRole('listbox')
    Object.defineProperty(menu, 'clientHeight', { value: 32 })
    screen.getAllByRole('option').forEach((option, index) => {
      Object.defineProperty(option, 'offsetTop', { value: index * 30 })
      Object.defineProperty(option, 'offsetHeight', { value: 30 })
    })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(menu.scrollTop).toBe(28)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(menu.scrollTop).toBe(0)
  })

  it('保存期间禁用输入与展开，并隐藏已打开的菜单', () => {
    const view = render(<Controlled />)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
    view.rerender(<Controlled disabled />)
    expect((screen.getByRole('combobox') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Choose a model' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
