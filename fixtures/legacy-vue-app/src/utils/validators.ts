export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)

export function passwordProblems(pw: string): string[] {
  const problems = []
  if (pw.length < 8) problems.push('at least 8 characters')
  if (!/[A-Z]/.test(pw)) problems.push('one uppercase letter')
  if (!/[0-9]/.test(pw)) problems.push('one number')
  return problems
}
