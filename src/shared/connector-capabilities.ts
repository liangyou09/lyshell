/** 真实适配器声明的能力；不从统一 connect/write 接口推断协议能力。 */
export interface ConnectorCapabilities {
  interactiveInput: boolean
  resize: boolean
  exec: boolean
  fileTransfer: boolean
  pauseOutput: boolean
  reattach: boolean
}
