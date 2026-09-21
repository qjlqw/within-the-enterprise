import { useState } from 'react'
import { Button, Modal, message } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'

interface DeleteConfirmProps {
  /** 确认删除回调 */
  onConfirm?: () => void | Promise<void>
  /** 确认框标题 */
  title?: string
  /** 按钮文字 */
  buttonText?: string
}

/**
 * 删除确认组件
 */
function DeleteConfirm({
  onConfirm,
  title = '确定删除？',
  buttonText = '删除',
}: DeleteConfirmProps) {
  const [open, setOpen] = useState<boolean>(false)
  const [confirmLoading, setConfirmLoading] = useState<boolean>(false)

  const handleOk = async () => {
    setConfirmLoading(true)
    try {
      await onConfirm?.()
      message.success('删除成功')
      setOpen(false)
    } catch (error) {
      console.error('删除失败:', error)
      message.error('删除失败')
    } finally {
      setConfirmLoading(false)
    }
  }

  return (
    <>
      <Button
        type="link"
        danger
        icon={<DeleteOutlined />}
        onClick={() => setOpen(true)}
      >
        {buttonText}
      </Button>
      <Modal
        title={title}
        open={open}
        confirmLoading={confirmLoading}
        onOk={handleOk}
        onCancel={() => setOpen(false)}
        okText="确认"
        cancelText="取消"
      />
    </>
  )
}

export default DeleteConfirm
