declare module "picomatch" {
  type Matcher = (input: string) => boolean
  export default function picomatch(
    pattern: string | string[],
    options?: { dot?: boolean },
  ): Matcher
}
