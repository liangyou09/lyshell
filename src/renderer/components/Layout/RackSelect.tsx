import React from 'react'

type RackSelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'multiple' | 'value' | 'defaultValue'> & { value: string }

/** 选择与键盘交互仍交给原生 select，独立显示层保证窄栏长文本不会盖住箭头。 */
const RackSelect: React.FC<RackSelectProps> = ({ children, className, value, title, ...props }) => {
  const options = React.Children.toArray(children).filter(React.isValidElement<React.OptionHTMLAttributes<HTMLOptionElement>>)
  const selected = options.find(option => String(option.props.value) === value)
  const label = selected?.props.label ?? selected?.props.children
  return <span className="rack-select-wrap">
    <select {...props} className={className} value={value}
      title={title ?? (typeof label === 'string' ? label : undefined)}>{children}</select>
    <span className="rack-select-value" aria-hidden="true">{label}</span>
  </span>
}

export default RackSelect
