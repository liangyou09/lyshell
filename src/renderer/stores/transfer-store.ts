import { create } from 'zustand'
import type { TransferTask } from '@shared/types'
import { TransferStatus, TransferDirection } from '@shared/types'

/**
 * 传输状态 - 简化版，不追踪进度，只记录结果
 */
interface TransferState {
  // 传输任务列表（只记录失败的任务，用于显示错误）
  failedTasks: TransferTask[]

  // 标记任务失败
  markFailed: (sessionId: string, fileName: string, error: string) => void

  // 清除失败任务
  clearFailed: () => void
}

/**
 * 传输状态 Store - 简化版
 */
export const useTransferStore = create<TransferState>((set) => ({
  failedTasks: [],

  markFailed: (sessionId, fileName, error) => {
    const task: TransferTask = {
      id: Date.now().toString(),
      sessionId,
      direction: TransferDirection.DOWNLOAD,
      localPath: '',
      remotePath: '',
      fileName,
      fileSize: 0,
      transferredSize: 0,
      progress: 0,
      status: TransferStatus.FAILED,
      error,
      startTime: new Date(),
      endTime: new Date()
    }
    set((state) => ({
      failedTasks: [...state.failedTasks, task]
    }))
  },

  clearFailed: () => {
    set({ failedTasks: [] })
  }
}))