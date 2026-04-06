declare module 'spark-md5' {
  const SparkMD5: {
    ArrayBuffer: {
      hash(input: ArrayBuffer): string
    }
  }

  export default SparkMD5
}